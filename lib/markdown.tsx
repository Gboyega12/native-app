import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { colors, fonts, spacing } from '@/theme';

interface Props {
  children: string;
}

/**
 * Lightweight markdown renderer for React Native.
 * Handles: **bold**, *italic*, `code`, bullet lists, numbered lists,
 * and paragraph breaks. No external dependencies.
 */
export default function Markdown({ children }: Props) {
  const paragraphs = children.split(/\n\n+/);
  return (
    <View style={styles.container}>
      {paragraphs.map((para, i) => (
        <Paragraph key={i} text={para} isLast={i === paragraphs.length - 1} />
      ))}
    </View>
  );
}

function Paragraph({ text, isLast }: { text: string; isLast: boolean }) {
  const lines = text.split('\n');

  // Detect bullet list: every non-empty line starts with - or *
  const isBulletList = lines.every(
    (l) => /^\s*[-*]\s/.test(l) || l.trim() === '',
  );
  if (isBulletList) {
    return (
      <View style={!isLast && styles.paragraphGap}>
        {lines.filter((l) => l.trim()).map((l, j) => {
          const content = l.replace(/^\s*[-*]\s+/, '');
          return (
            <View key={j} style={styles.listRow}>
              <Text style={styles.bullet}>{'\u2022'}</Text>
              <Text style={styles.listText}><Inline text={content} /></Text>
            </View>
          );
        })}
      </View>
    );
  }

  // Detect numbered list: every non-empty line starts with digit.
  const isNumberedList = lines.every(
    (l) => /^\s*\d+[.)]\s/.test(l) || l.trim() === '',
  );
  if (isNumberedList) {
    return (
      <View style={!isLast && styles.paragraphGap}>
        {lines.filter((l) => l.trim()).map((l, j) => {
          const content = l.replace(/^\s*\d+[.)]\s+/, '');
          return (
            <View key={j} style={styles.listRow}>
              <Text style={styles.listNumber}>{j + 1}.</Text>
              <Text style={styles.listText}><Inline text={content} /></Text>
            </View>
          );
        })}
      </View>
    );
  }

  // Regular paragraph (may contain single line breaks)
  const joined = lines.join('\n');
  return (
    <Text style={[styles.paragraph, !isLast && styles.paragraphGap]}>
      <Inline text={joined} />
    </Text>
  );
}

/**
 * Parse inline markdown: **bold**, *italic*, `code`
 * Returns an array of <Text> nodes.
 */
function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  // Regex matches **bold**, *italic*, or `code` (non-greedy)
  const rx = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = rx.exec(text)) !== null) {
    // Push text before match
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }

    if (match[2]) {
      // **bold**
      parts.push(
        <Text key={match.index} style={styles.bold}>{match[2]}</Text>,
      );
    } else if (match[3]) {
      // *italic*
      parts.push(
        <Text key={match.index} style={styles.italic}>{match[3]}</Text>,
      );
    } else if (match[4]) {
      // `code`
      parts.push(
        <Text key={match.index} style={styles.code}>{match[4]}</Text>,
      );
    }

    last = match.index + match[0].length;
  }

  // Remaining text
  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return <>{parts}</>;
}

const styles = StyleSheet.create({
  container: {},
  paragraph: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    color: colors.text2,
  },
  paragraphGap: {
    marginBottom: spacing.sm + 2,
  },
  bold: {
    fontFamily: fonts.semibold,
    color: colors.text,
  },
  italic: {
    fontStyle: 'italic',
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 13,
    backgroundColor: 'rgba(255,255,255,0.06)',
    color: colors.accent,
  },
  listRow: {
    flexDirection: 'row',
    marginBottom: 4,
    paddingRight: spacing.md,
  },
  bullet: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    color: colors.accent,
    width: 18,
  },
  listNumber: {
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 22,
    color: colors.accent,
    width: 22,
  },
  listText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    color: colors.text2,
  },
});
