import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput,
  LayoutAnimation, ActivityIndicator, Modal, Pressable, Linking,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useResponsive } from '@/lib/responsive';
import Card, { CardTitle, CardTitleRow, SMOOTH_ANIM } from '@/components/Card';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { useAppData } from '@/hooks/useAppData';

// ── UK regulatory constants ──
const IHT_NIL_RATE_BAND = 325000;
const IHT_RESIDENCE_NIL_RATE_BAND = 175000;
const IHT_RATE = 0.40;
const ISA_ANNUAL_LIMIT = 20000;
const CGT_ANNUAL_EXEMPTION = 3000;
const PENSION_ANNUAL_ALLOWANCE = 60000;

interface EstatePlanDocument {
  id?: string;
  type: 'will' | 'trust' | 'lpa_health' | 'lpa_finance' | 'expression_of_wishes';
  status: 'not_started' | 'in_progress' | 'completed' | 'notarised';
  data: Record<string, unknown>;
  updated_at?: string;
}

type DocumentType = EstatePlanDocument['type'];

const DOC_TYPES: { value: DocumentType; label: string; description: string }[] = [
  { value: 'will', label: 'Last Will & Testament', description: 'Distribute your estate according to your wishes' },
  { value: 'trust', label: 'Trust Deed', description: 'Set up a trust to protect and manage assets' },
  { value: 'lpa_health', label: 'LPA (Health & Welfare)', description: 'Appoint someone to make health decisions for you' },
  { value: 'lpa_finance', label: 'LPA (Property & Finance)', description: 'Appoint someone to manage your finances' },
  { value: 'expression_of_wishes', label: 'Expression of Wishes', description: 'Guide trustees on how to use trust assets' },
];

// ── Will form sections (UK-specific) ──
interface WillFormData {
  full_name: string;
  address: string;
  date_of_birth: string;
  marital_status: 'single' | 'married' | 'civil_partnership' | 'divorced' | 'widowed';
  executors: Array<{ name: string; address: string; relationship: string }>;
  guardians: Array<{ name: string; address: string }>;
  beneficiaries: Array<{ name: string; relationship: string; share_percentage: number; specific_gifts?: string }>;
  specific_gifts: Array<{ item: string; recipient: string }>;
  residuary_estate: string;
  funeral_wishes: string;
  digital_assets_instructions: string;
}

export default function EstatePlanning() {
  const router = useRouter();
  const { colors } = useTheme();
  const { maxContentWidth, isTablet, horizontalPadding } = useResponsive();
  const s = useMemo(() => createStyles(colors), [colors]);
  const appData = useAppData();

  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<EstatePlanDocument[]>([]);
  const [properties, setProperties] = useState<Array<{ estimated_value: number; mortgage_balance: number | null; has_mortgage: boolean }>>([]);
  const [expandedDoc, setExpandedDoc] = useState<DocumentType | null>(null);
  const [showNewDocModal, setShowNewDocModal] = useState(false);
  const [selectedDocType, setSelectedDocType] = useState<DocumentType | null>(null);

  // Will form state
  const [willForm, setWillForm] = useState<Partial<WillFormData>>({
    executors: [{ name: '', address: '', relationship: '' }],
    guardians: [],
    beneficiaries: [{ name: '', relationship: '', share_percentage: 100 }],
    specific_gifts: [],
  });
  const [willStep, setWillStep] = useState(0);
  const [savingDoc, setSavingDoc] = useState(false);

  // Tax data from agent
  const taxAnalysis = (appData.analysis as any)?.tax_estate_analysis?.tax_analysis;
  const estateAnalysis = (appData.analysis as any)?.tax_estate_analysis?.estate_analysis;

  // Compute estate summary
  const analysis = appData.analysis;
  const monthlyIncome = analysis?.monthly_income || 0;
  const annualIncome = monthlyIncome * 12;

  const propertyValue = properties.reduce((s, p) => s + p.estimated_value, 0);
  const mortgageDebt = properties.reduce((s, p) => s + (p.has_mortgage && p.mortgage_balance ? p.mortgage_balance : 0), 0);
  const investmentValue = (appData.investments || []).reduce((s: number, i: any) => s + (i.current_value || 0), 0);
  const estimatedEstate = propertyValue + investmentValue + (analysis?.surplus || 0) * 12; // rough
  const ihtLiability = Math.max(0, (estimatedEstate - IHT_NIL_RATE_BAND - IHT_RESIDENCE_NIL_RATE_BAND) * IHT_RATE);

  useFocusEffect(
    useCallback(() => {
      trackScreen('Estate Planning');
      loadData();
    }, [])
  );

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      const [{ data: docs }, { data: props }] = await Promise.all([
        supabase
          .from('estate_documents')
          .select('*')
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false }),
        supabase
          .from('properties')
          .select('estimated_value, mortgage_balance, has_mortgage')
          .eq('user_id', user.id),
      ]);

      if (docs) setDocuments(docs);
      if (props) setProperties(props);
    } catch (err) {
      console.warn('[estate] loadData error:', err);
    }
    setLoading(false);
  };

  const handleStartDocument = (type: DocumentType) => {
    trackEvent('Estate Document Started', { type });
    hapticMedium();
    setSelectedDocType(type);
    setWillStep(0);
    setShowNewDocModal(true);
  };

  const handleSaveDocument = async () => {
    if (!selectedDocType) return;
    setSavingDoc(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setSavingDoc(false); return; }

      const doc = {
        user_id: user.id,
        type: selectedDocType,
        status: 'in_progress' as const,
        data: selectedDocType === 'will' ? willForm : {},
        updated_at: new Date().toISOString(),
      };

      const existing = documents.find(d => d.type === selectedDocType);
      if (existing?.id) {
        await supabase.from('estate_documents').update(doc).eq('id', existing.id);
      } else {
        const { data } = await supabase.from('estate_documents').insert(doc).select().maybeSingle();
        if (data) setDocuments(prev => [...prev, data]);
      }

      hapticSuccess();
      trackEvent('Estate Document Saved', { type: selectedDocType });
      setShowNewDocModal(false);
      await loadData();
    } catch (err) {
      console.warn('[estate] save error:', err);
    }
    setSavingDoc(false);
  };

  // ── Will form steps ──
  const WILL_STEPS = ['Personal details', 'Executors', 'Beneficiaries', 'Specific gifts', 'Funeral & digital'];

  const renderWillStep = () => {
    switch (willStep) {
      case 0:
        return (
          <View>
            <Text style={s.formLabel}>Full legal name</Text>
            <TextInput style={s.formInput} value={willForm.full_name || ''} onChangeText={(v) => setWillForm(p => ({ ...p, full_name: v }))} placeholder="As on your passport" placeholderTextColor={colors.muted} />

            <Text style={s.formLabel}>Address</Text>
            <TextInput style={s.formInput} value={willForm.address || ''} onChangeText={(v) => setWillForm(p => ({ ...p, address: v }))} placeholder="Full address" placeholderTextColor={colors.muted} multiline />

            <Text style={s.formLabel}>Date of birth</Text>
            <TextInput style={s.formInput} value={willForm.date_of_birth || ''} onChangeText={(v) => setWillForm(p => ({ ...p, date_of_birth: v }))} placeholder="DD/MM/YYYY" placeholderTextColor={colors.muted} />

            <Text style={s.formLabel}>Marital status</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {(['single', 'married', 'civil_partnership', 'divorced', 'widowed'] as const).map(status => (
                <TouchableOpacity key={status} style={[s.chip, willForm.marital_status === status && s.chipActive]} onPress={() => setWillForm(p => ({ ...p, marital_status: status }))} activeOpacity={0.7}>
                  <Text style={[s.chipText, willForm.marital_status === status && s.chipTextActive]}>
                    {status.replace('_', ' ')}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        );
      case 1:
        return (
          <View>
            <Text style={s.formHint}>Executors carry out your wishes. Appoint at least one trusted person.</Text>
            {(willForm.executors || []).map((ex, idx) => (
              <View key={idx} style={s.formGroup}>
                <Text style={s.formLabel}>Executor {idx + 1}</Text>
                <TextInput style={s.formInput} value={ex.name} onChangeText={(v) => {
                  const exs = [...(willForm.executors || [])];
                  exs[idx] = { ...exs[idx], name: v };
                  setWillForm(p => ({ ...p, executors: exs }));
                }} placeholder="Full name" placeholderTextColor={colors.muted} />
                <TextInput style={s.formInput} value={ex.relationship} onChangeText={(v) => {
                  const exs = [...(willForm.executors || [])];
                  exs[idx] = { ...exs[idx], relationship: v };
                  setWillForm(p => ({ ...p, executors: exs }));
                }} placeholder="Relationship (e.g. spouse, sibling)" placeholderTextColor={colors.muted} />
              </View>
            ))}
            <TouchableOpacity onPress={() => {
              setWillForm(p => ({ ...p, executors: [...(p.executors || []), { name: '', address: '', relationship: '' }] }));
            }} activeOpacity={0.7}>
              <Text style={s.addMoreText}>+ Add another executor</Text>
            </TouchableOpacity>
          </View>
        );
      case 2:
        return (
          <View>
            <Text style={s.formHint}>Who should receive your estate? Shares should total 100%.</Text>
            {(willForm.beneficiaries || []).map((ben, idx) => (
              <View key={idx} style={s.formGroup}>
                <Text style={s.formLabel}>Beneficiary {idx + 1}</Text>
                <TextInput style={s.formInput} value={ben.name} onChangeText={(v) => {
                  const bens = [...(willForm.beneficiaries || [])];
                  bens[idx] = { ...bens[idx], name: v };
                  setWillForm(p => ({ ...p, beneficiaries: bens }));
                }} placeholder="Full name" placeholderTextColor={colors.muted} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput style={[s.formInput, { flex: 1 }]} value={ben.relationship} onChangeText={(v) => {
                    const bens = [...(willForm.beneficiaries || [])];
                    bens[idx] = { ...bens[idx], relationship: v };
                    setWillForm(p => ({ ...p, beneficiaries: bens }));
                  }} placeholder="Relationship" placeholderTextColor={colors.muted} />
                  <TextInput style={[s.formInput, { width: 80 }]} value={String(ben.share_percentage || '')} onChangeText={(v) => {
                    const bens = [...(willForm.beneficiaries || [])];
                    bens[idx] = { ...bens[idx], share_percentage: parseInt(v) || 0 };
                    setWillForm(p => ({ ...p, beneficiaries: bens }));
                  }} placeholder="%" placeholderTextColor={colors.muted} keyboardType="number-pad" />
                </View>
              </View>
            ))}
            <TouchableOpacity onPress={() => {
              setWillForm(p => ({ ...p, beneficiaries: [...(p.beneficiaries || []), { name: '', relationship: '', share_percentage: 0 }] }));
            }} activeOpacity={0.7}>
              <Text style={s.addMoreText}>+ Add another beneficiary</Text>
            </TouchableOpacity>
          </View>
        );
      case 3:
        return (
          <View>
            <Text style={s.formHint}>Leave specific items to specific people (e.g. jewellery, car, art).</Text>
            {(willForm.specific_gifts || []).map((gift, idx) => (
              <View key={idx} style={s.formGroup}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput style={[s.formInput, { flex: 1 }]} value={gift.item} onChangeText={(v) => {
                    const gifts = [...(willForm.specific_gifts || [])];
                    gifts[idx] = { ...gifts[idx], item: v };
                    setWillForm(p => ({ ...p, specific_gifts: gifts }));
                  }} placeholder="Item description" placeholderTextColor={colors.muted} />
                  <TextInput style={[s.formInput, { flex: 1 }]} value={gift.recipient} onChangeText={(v) => {
                    const gifts = [...(willForm.specific_gifts || [])];
                    gifts[idx] = { ...gifts[idx], recipient: v };
                    setWillForm(p => ({ ...p, specific_gifts: gifts }));
                  }} placeholder="Recipient" placeholderTextColor={colors.muted} />
                </View>
              </View>
            ))}
            <TouchableOpacity onPress={() => {
              setWillForm(p => ({ ...p, specific_gifts: [...(p.specific_gifts || []), { item: '', recipient: '' }] }));
            }} activeOpacity={0.7}>
              <Text style={s.addMoreText}>+ Add gift</Text>
            </TouchableOpacity>
          </View>
        );
      case 4:
        return (
          <View>
            <Text style={s.formLabel}>Funeral wishes <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={[s.formInput, { minHeight: 60 }]} value={willForm.funeral_wishes || ''} onChangeText={(v) => setWillForm(p => ({ ...p, funeral_wishes: v }))} placeholder="e.g. burial/cremation preferences" placeholderTextColor={colors.muted} multiline />

            <Text style={s.formLabel}>Digital assets instructions <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={[s.formInput, { minHeight: 60 }]} value={willForm.digital_assets_instructions || ''} onChangeText={(v) => setWillForm(p => ({ ...p, digital_assets_instructions: v }))} placeholder="How to handle social media, crypto, email accounts..." placeholderTextColor={colors.muted} multiline />
          </View>
        );
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={[
        s.scroll,
        isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%', paddingHorizontal: horizontalPadding },
      ]}
    >
      <Text style={s.heading}>Estate Planning</Text>
      <Text style={s.subtitle}>Prepare for the future. Build your will, set up trusts, and get your affairs in order — all within UK regulations.</Text>

      {/* ── Estate summary card ── */}
      <Card style={{ marginBottom: spacing.md }}>
        <CardTitleRow
          title="Estate Overview"
          right={
            <Text style={{ fontFamily: fonts.mono, fontSize: 16, color: colors.text }}>
              {'\u00a3'}{Math.round(estimatedEstate).toLocaleString()}
            </Text>
          }
        />
        <View style={{ gap: 8, marginTop: 8 }}>
          {propertyValue > 0 && (
            <View style={s.summaryRow}>
              <Text style={s.summaryLabel}>Property</Text>
              <Text style={s.summaryValue}>{'\u00a3'}{Math.round(propertyValue).toLocaleString()}</Text>
            </View>
          )}
          {investmentValue > 0 && (
            <View style={s.summaryRow}>
              <Text style={s.summaryLabel}>Investments</Text>
              <Text style={s.summaryValue}>{'\u00a3'}{Math.round(investmentValue).toLocaleString()}</Text>
            </View>
          )}
          {mortgageDebt > 0 && (
            <View style={s.summaryRow}>
              <Text style={[s.summaryLabel, { color: colors.coral }]}>Mortgage debt</Text>
              <Text style={[s.summaryValue, { color: colors.coral }]}>-{'\u00a3'}{Math.round(mortgageDebt).toLocaleString()}</Text>
            </View>
          )}
          <View style={[s.summaryRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 8, marginTop: 4 }]}>
            <Text style={[s.summaryLabel, { fontFamily: fonts.semibold, color: colors.text }]}>
              Estimated IHT liability
            </Text>
            <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: ihtLiability > 0 ? colors.coral : colors.green }}>
              {ihtLiability > 0 ? `\u00a3${Math.round(ihtLiability).toLocaleString()}` : 'None'}
            </Text>
          </View>
          {ihtLiability > 0 && (
            <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.muted, lineHeight: 16, marginTop: 4 }}>
              Based on {'\u00a3'}{IHT_NIL_RATE_BAND.toLocaleString()} nil rate band + {'\u00a3'}{IHT_RESIDENCE_NIL_RATE_BAND.toLocaleString()} residence nil rate band. Speak to an adviser for personalised guidance.
            </Text>
          )}
        </View>
      </Card>

      {/* ── Tax position card (from agent) ── */}
      {taxAnalysis && (
        <Card style={{ marginBottom: spacing.md }}>
          <CardTitle color={colors.accent}>TAX POSITION</CardTitle>
          <View style={{ gap: 8, marginTop: 4 }}>
            <View style={s.summaryRow}>
              <Text style={s.summaryLabel}>Effective tax rate</Text>
              <Text style={s.summaryValue}>{(taxAnalysis.effective_tax_rate * 100).toFixed(1)}%</Text>
            </View>
            <View style={s.summaryRow}>
              <Text style={s.summaryLabel}>Annual tax drag</Text>
              <Text style={[s.summaryValue, { color: colors.coral }]}>{'\u00a3'}{taxAnalysis.annual_tax_drag.toLocaleString()}/yr</Text>
            </View>
            {taxAnalysis.wrapper_utilisation && (
              <>
                <View style={s.summaryRow}>
                  <Text style={s.summaryLabel}>ISA used / remaining</Text>
                  <Text style={s.summaryValue}>{'\u00a3'}{taxAnalysis.wrapper_utilisation.isa_used.toLocaleString()} / {'\u00a3'}{taxAnalysis.wrapper_utilisation.isa_remaining.toLocaleString()}</Text>
                </View>
                <View style={s.summaryRow}>
                  <Text style={s.summaryLabel}>CGT allowance remaining</Text>
                  <Text style={s.summaryValue}>{'\u00a3'}{taxAnalysis.cgt_position?.allowance_remaining?.toLocaleString() || CGT_ANNUAL_EXEMPTION.toLocaleString()}</Text>
                </View>
              </>
            )}
          </View>
          <TouchableOpacity
            style={s.ctaBtn}
            onPress={() => router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: 'Help me optimise my tax position for this tax year.' } })}
            activeOpacity={0.7}
          >
            <Text style={s.ctaBtnText}>Get tax optimisation advice</Text>
          </TouchableOpacity>
        </Card>
      )}

      {/* ── Documents section ── */}
      <View style={{ marginBottom: spacing.md }}>
        <Text style={s.sectionTitle}>Your Documents</Text>
        <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.muted, marginBottom: 16 }}>
          Build legally-structured documents you can download, notarise, and store safely.
        </Text>

        {DOC_TYPES.map((dt) => {
          const existing = documents.find(d => d.type === dt.value);
          const isExpanded = expandedDoc === dt.value;
          const statusColor = existing?.status === 'notarised' ? colors.green
            : existing?.status === 'completed' ? colors.accent
            : existing?.status === 'in_progress' ? colors.amber
            : colors.muted;
          const statusLabel = existing?.status === 'notarised' ? 'Notarised'
            : existing?.status === 'completed' ? 'Ready to notarise'
            : existing?.status === 'in_progress' ? 'In progress'
            : 'Not started';

          return (
            <TouchableOpacity
              key={dt.value}
              onPress={() => {
                hapticLight();
                LayoutAnimation.configureNext(SMOOTH_ANIM);
                setExpandedDoc(isExpanded ? null : dt.value);
              }}
              activeOpacity={0.7}
            >
              <Card variant="default" style={{ marginBottom: spacing.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}>{dt.label}</Text>
                    <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.muted, marginTop: 2 }}>{dt.description}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <View style={{ backgroundColor: `${statusColor}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: statusColor }}>{statusLabel}</Text>
                    </View>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.dim, marginTop: 4 }}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                  </View>
                </View>
                {isExpanded && (
                  <View style={{ marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 12 }}>
                    <TouchableOpacity
                      style={s.ctaBtn}
                      onPress={() => handleStartDocument(dt.value)}
                      activeOpacity={0.7}
                    >
                      <Text style={s.ctaBtnText}>
                        {existing ? 'Continue editing' : 'Start now'}
                      </Text>
                    </TouchableOpacity>
                    {existing && (
                      <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, textAlign: 'center', marginTop: 6 }}>
                        Last updated: {existing.updated_at ? new Date(existing.updated_at).toLocaleDateString() : 'N/A'}
                      </Text>
                    )}
                  </View>
                )}
              </Card>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Professional services ── */}
      <Card style={{ marginBottom: spacing.md }}>
        <CardTitle color={colors.accent}>PROFESSIONAL SERVICES</CardTitle>
        <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.muted, marginBottom: 12 }}>
          For complex estates, we recommend professional guidance.
        </Text>

        <TouchableOpacity
          style={[s.serviceBtn, { marginBottom: 8 }]}
          onPress={() => {
            trackEvent('Advisor Consultation Tapped');
            router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: 'I want to speak to a financial advisor about my estate planning. What are my options?' } });
          }}
          activeOpacity={0.7}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}>Speak to an advisor</Text>
            <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.muted }}>FCA-regulated financial advisors</Text>
          </View>
          <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.accent }}>{'\u2192'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.serviceBtn, { marginBottom: 8 }]}
          onPress={() => {
            trackEvent('Tax Filing Tapped');
            router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: 'Help me understand what I need to file for my Self Assessment tax return this year.' } });
          }}
          activeOpacity={0.7}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}>File your taxes</Text>
            <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.muted }}>Self Assessment guidance & preparation</Text>
          </View>
          <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.accent }}>{'\u2192'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={s.serviceBtn}
          onPress={() => {
            trackEvent('Notarise Document Tapped');
            Linking.openURL('https://www.gov.uk/get-document-legalised');
          }}
          activeOpacity={0.7}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}>Notarise documents</Text>
            <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.muted }}>Official document legalisation (GOV.UK)</Text>
          </View>
          <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.accent }}>{'\u2192'}</Text>
        </TouchableOpacity>
      </Card>

      {/* ── Legal disclaimer ── */}
      <Text style={s.disclaimer}>
        This tool helps you prepare estate planning documents based on standard UK templates.
        It does not constitute legal advice. We recommend having documents reviewed by a solicitor
        before execution. Tax figures are estimates based on current HMRC rates (2025/26).
        Always consult a qualified adviser for personalised tax planning.
      </Text>

      {/* ── Document editor modal ── */}
      <Modal visible={showNewDocModal} transparent animationType="fade" onRequestClose={() => setShowNewDocModal(false)}>
        <Pressable style={s.modalOverlay} onPress={() => setShowNewDocModal(false)}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={s.modalHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={s.modalTitle}>
                    {DOC_TYPES.find(d => d.value === selectedDocType)?.label || 'Document'}
                  </Text>
                  {selectedDocType === 'will' && (
                    <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted, letterSpacing: 0.5, marginTop: 4 }}>
                      Step {willStep + 1} of {WILL_STEPS.length}: {WILL_STEPS[willStep]}
                    </Text>
                  )}
                </View>
                <TouchableOpacity onPress={() => setShowNewDocModal(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Text style={{ fontSize: 16, color: colors.muted }}>{'\u2715'}</Text>
                </TouchableOpacity>
              </View>

              {/* Step progress bar */}
              {selectedDocType === 'will' && (
                <View style={{ flexDirection: 'row', gap: 4, marginBottom: 16 }}>
                  {WILL_STEPS.map((_, idx) => (
                    <View key={idx} style={{
                      flex: 1, height: 3, borderRadius: 2,
                      backgroundColor: idx <= willStep ? colors.accent : colors.border,
                    }} />
                  ))}
                </View>
              )}

              {selectedDocType === 'will' ? renderWillStep() : (
                <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22 }}>
                  This document type is coming soon. In the meantime, chat with Bocy for guidance on {DOC_TYPES.find(d => d.value === selectedDocType)?.label?.toLowerCase()}.
                </Text>
              )}

              {/* Navigation buttons */}
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
                {selectedDocType === 'will' && willStep > 0 && (
                  <TouchableOpacity
                    style={[s.ctaBtn, { flex: 1, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border }]}
                    onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setWillStep(s => s - 1); }}
                    activeOpacity={0.7}
                  >
                    <Text style={[s.ctaBtnText, { color: colors.text }]}>Back</Text>
                  </TouchableOpacity>
                )}
                {selectedDocType === 'will' && willStep < WILL_STEPS.length - 1 ? (
                  <TouchableOpacity
                    style={[s.ctaBtn, { flex: 1 }]}
                    onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setWillStep(s => s + 1); }}
                    activeOpacity={0.7}
                  >
                    <Text style={s.ctaBtnText}>Next</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[s.ctaBtn, { flex: 1 }]}
                    onPress={handleSaveDocument}
                    disabled={savingDoc}
                    activeOpacity={0.7}
                  >
                    {savingDoc ? (
                      <ActivityIndicator color={colors.bg} size="small" />
                    ) : (
                      <Text style={s.ctaBtnText}>Save & store safely</Text>
                    )}
                  </TouchableOpacity>
                )}
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const createStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24, paddingTop: 60, paddingBottom: 40 },

  heading: { fontFamily: fonts.semibold, fontSize: 24, color: c.text, marginBottom: 8 },
  subtitle: { fontFamily: fonts.regular, fontSize: 14, color: c.dim, marginBottom: 24, lineHeight: 20 },

  sectionTitle: { fontFamily: fonts.semibold, fontSize: 16, color: c.text, marginBottom: 4 },

  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { fontFamily: fonts.regular, fontSize: 13, color: c.text2 },
  summaryValue: { fontFamily: fonts.mono, fontSize: 13, color: c.text },

  ctaBtn: {
    backgroundColor: c.accent, borderRadius: 10,
    paddingVertical: 12, alignItems: 'center', marginTop: 8,
  },
  ctaBtnText: { fontFamily: fonts.semibold, fontSize: 14, color: c.bg },

  serviceBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },

  disclaimer: {
    fontFamily: fonts.regular, fontSize: 11, color: c.dim,
    lineHeight: 16, marginTop: 8, marginBottom: 24,
  },

  // Form styles
  formLabel: { fontFamily: fonts.medium, fontSize: 13, color: c.text2, marginBottom: 6, marginTop: 12 },
  formInput: {
    fontFamily: fonts.regular, fontSize: 15, color: c.text,
    borderWidth: 1, borderColor: c.border, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 4,
  },
  formHint: { fontFamily: fonts.regular, fontSize: 12, color: c.muted, lineHeight: 18, marginBottom: 12 },
  formGroup: { marginBottom: 12, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  optional: { fontFamily: fonts.regular, fontSize: 11, color: c.muted },
  addMoreText: { fontFamily: fonts.mono, fontSize: 12, color: c.accent, paddingVertical: 8 },

  chip: {
    borderWidth: 1, borderColor: c.border, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 6, marginRight: 8,
  },
  chipActive: { borderColor: c.accent, backgroundColor: c.accentDim },
  chipText: { fontFamily: fonts.regular, fontSize: 13, color: c.muted },
  chipTextActive: { color: c.accent },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  modalContent: {
    backgroundColor: c.surface, borderRadius: 20, padding: 24,
    width: '100%', maxWidth: 480, maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16,
  },
  modalTitle: { fontFamily: fonts.semibold, fontSize: 18, color: c.text },
});
