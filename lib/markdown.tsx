import React, { useMemo, createContext, useContext } from 'react';
import { Text, View, Image, StyleSheet } from 'react-native';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';

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

function Paragraph({ text, isLast }: { text: string; isLast: boolean }) {
  const s = useMdStyles();
  const lines = text.split('\n');

  // Detect GIF image: a single-line paragraph with ![...](url)
  if (lines.length === 1) {
    const gifMatch = lines[0].match(GIF_LINE_RX);
    if (gifMatch) {
      return (
        <View style={[s.gifContainer, !isLast && s.paragraphGap]}>
          <Image source={{ uri: gifMatch[1] }} style={s.gif} resizeMode="cover" />
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
            <Image source={{ uri: gifMatch[1] }} style={s.gif} resizeMode="cover" />
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

/**
 * Parse inline markdown: **bold**, *italic*, `code`
 * Returns an array of <Text> nodes.
 */
function Inline({ text }: { text: string }) {
  const s = useMdStyles();
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
        <Text key={match.index} style={s.bold}>{match[2]}</Text>,
      );
    } else if (match[3]) {
      // *italic*
      parts.push(
        <Text key={match.index} style={s.italic}>{match[3]}</Text>,
      );
    } else if (match[4]) {
      // `code`
      parts.push(
        <Text key={match.index} style={s.code}>{match[4]}</Text>,
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
    fontSize: 14,
    lineHeight: 22,
    color: c.text2,
  },
  paragraphGap: {
    marginBottom: spacing.sm + 2,
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
  listRow: {
    flexDirection: 'row',
    marginBottom: 4,
    paddingRight: spacing.md,
  },
  bullet: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    color: c.accent,
    width: 18,
  },
  listNumber: {
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 22,
    color: c.accent,
    width: 22,
  },
  listText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    color: c.text2,
  },
  // GIF images
  gifContainer: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  gif: {
    width: 200,
    height: 150,
    borderRadius: radius.md,
  },
});
