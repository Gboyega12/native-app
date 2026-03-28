import React, { useMemo, useState, createContext, useContext } from 'react';
import { Text, View, StyleSheet, Linking } from 'react-native';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useRouter } from 'expo-router';

interface Props {
  children: string;
}

/** Matches `![alt](url)` on its own line */
const GIF_LINE_RX = /^!\[.*?\]\((https?:\/\/[^\s)]+)\)\s*$/;

// Internal context to pass styles down without prop drilling
const MdStylesCtx = createContext<ReturnType<typeof createStyles> | null>(null);

/**
 * Lightweight markdown renderer for React Native.
 * Handles: **bold**, *italic*, `code`, bullet lists, numbered lists,
 * ![gif](url) images, and paragraph breaks. No external dependencies.
 */
export default function Markdown({ children }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const paragraphs = children.split(/\n\n+/);
  return (
    <MdStylesCtx.Provider value={s}>
      <View>
        {paragraphs.map((para, i) => (
          <Paragraph key={i} text={para} isLast={i === paragraphs.length - 1} />
        ))}
      </View>
    </MdStylesCtx.Provider>
  );
}

function useMdStyles() {
  return useContext(MdStylesCtx)!;
}

/** Renders GIF images — uses native <img> on web for reliable GIF playback.
 *  Hides itself when the URL fails to load (e.g. fabricated/expired URLs). */
function GifImage({ uri, style }: { uri: string; style: any }) {
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return React.createElement('img', {
    src: uri,
    alt: '',
    onError: () => setFailed(true),
    style: {
      width: '100%',
      aspectRatio: '4 / 3',
      borderRadius: style.borderRadius ?? 0,
      objectFit: 'cover',
      display: 'block',
    },
  });
}

function Paragraph({ text, isLast }: { text: string; isLast: boolean }) {
  const s = useMdStyles();
  const lines = text.split('\n');

  // Detect GIF image: a single-line paragraph with ![...](url)
  if (lines.length === 1) {
    const gifMatch = lines[0].match(GIF_LINE_RX);
    if (gifMatch) {
      return (
        <View style={[s.gifContainer, !isLast && s.paragraphGap]}>
          <GifImage uri={gifMatch[1]} style={s.gif} />
        </View>
      );
    }
  }

  // Mixed content: paragraph may contain text lines AND a gif line.
  // Split into text chunks and gif chunks rendered sequentially.
  const hasGif = lines.some((l) => GIF_LINE_RX.test(l));
  if (hasGif) {
    const elements: React.ReactNode[] = [];
    let textBuffer: string[] = [];

    const flushText = (key: string) => {
      if (textBuffer.length === 0) return;
      const joined = textBuffer.join('\n');
      elements.push(
        <Text key={key} style={s.paragraph}>
          <Inline text={joined} />
        </Text>,
      );
      textBuffer = [];
    };

    lines.forEach((line, j) => {
      const gifMatch = line.match(GIF_LINE_RX);
      if (gifMatch) {
        flushText(`t-${j}`);
        elements.push(
          <View key={`g-${j}`} style={s.gifContainer}>
            <GifImage uri={gifMatch[1]} style={s.gif} />
          </View>,
        );
      } else {
        textBuffer.push(line);
      }
    });
    flushText('t-end');

    return <View style={!isLast ? s.paragraphGap : undefined}>{elements}</View>;
  }

  // Detect bullet list: every non-empty line starts with - or *
  const isBulletList = lines.every(
    (l) => /^\s*[-*]\s/.test(l) || l.trim() === '',
  );
  if (isBulletList) {
    return (
      <View style={!isLast && s.paragraphGap}>
        {lines.filter((l) => l.trim()).map((l, j) => {
          const content = l.replace(/^\s*[-*]\s+/, '');
          return (
            <View key={j} style={s.listRow}>
              <Text style={s.bullet}>{'\u2022'}</Text>
              <Text style={s.listText}><Inline text={content} /></Text>
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
      <View style={!isLast && s.paragraphGap}>
        {lines.filter((l) => l.trim()).map((l, j) => {
          const content = l.replace(/^\s*\d+[.)]\s+/, '');
          return (
            <View key={j} style={s.listRow}>
              <Text style={s.listNumber}>{j + 1}.</Text>
              <Text style={s.listText}><Inline text={content} /></Text>
            </View>
          );
        })}
      </View>
    );
  }

  // Regular paragraph (may contain single line breaks)
  const joined = lines.join('\n');
  return (
    <Text style={[s.paragraph, !isLast && s.paragraphGap]}>
      <Inline text={joined} />
    </Text>
  );
}

/** Safe URL check — only allow http/https and bocy:// deep links */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//.test(url) || /^bocy:\/\//.test(url);
}

function handleLinkPress(url: string) {
  if (!isSafeUrl(url)) return;
  if (url.startsWith('bocy://')) {
    // Deep link: bocy://profile → /(main)/profile
    const screen = url.replace('bocy://', '');
    // Router navigation is handled by the component tree — use Linking for now
    Linking.openURL(url).catch(() => {});
  } else {
    Linking.openURL(url).catch(() => {});
  }
}

/**
 * Parse inline markdown: **bold**, *italic*, `code`, [text](url)
 * Returns an array of <Text> nodes.
 */
function Inline({ text }: { text: string }) {
  const s = useMdStyles();
  const parts: React.ReactNode[] = [];
  // Regex matches [link](url), **bold**, *italic*, or `code` (non-greedy)
  const rx = /(\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = rx.exec(text)) !== null) {
    // Push text before match
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }

    if (match[2] && match[3]) {
      // [text](url) — markdown link
      const linkText = match[2];
      const linkUrl = match[3];
      parts.push(
        <Text
          key={match.index}
          style={s.link}
          onPress={() => handleLinkPress(linkUrl)}
          accessibilityRole="link"
        >
          {linkText}
        </Text>,
      );
    } else if (match[4]) {
      // **bold**
      parts.push(
        <Text key={match.index} style={s.bold}>{match[4]}</Text>,
      );
    } else if (match[5]) {
      // *italic*
      parts.push(
        <Text key={match.index} style={s.italic}>{match[5]}</Text>,
      );
    } else if (match[6]) {
      // `code`
      parts.push(
        <Text key={match.index} style={s.code}>{match[6]}</Text>,
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

const createStyles = (c: ThemeColors) => StyleSheet.create({
  paragraph: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 24,
    color: c.text2,
  },
  paragraphGap: {
    marginBottom: spacing.sm + 4,
  },
  bold: {
    fontFamily: fonts.semibold,
    color: c.text,
  },
  italic: {
    fontStyle: 'italic',
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 13,
    backgroundColor: c.accentDim,
    color: c.accent,
  },
  link: {
    color: c.accent,
    textDecorationLine: 'underline',
  },
  listRow: {
    flexDirection: 'row',
    marginBottom: 6,
    paddingRight: spacing.md,
  },
  bullet: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 24,
    color: c.accent,
    width: 18,
  },
  listNumber: {
    fontFamily: fonts.medium,
    fontSize: 15,
    lineHeight: 24,
    color: c.accent,
    width: 22,
  },
  listText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 24,
    color: c.text2,
  },
  // GIF images
  gifContainer: {
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignSelf: 'stretch',
  },
  gif: {
    width: '100%' as any,
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
  },
});
