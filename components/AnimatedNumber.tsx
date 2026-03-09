import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, type StyleProp, type TextStyle } from 'react-native';

interface AnimatedNumberProps {
  /** Target value to animate towards */
  value: number;
  /** Optional prefix (e.g. "£") */
  prefix?: string;
  /** Optional suffix (e.g. "/yr") */
  suffix?: string;
  /** Style applied to the Animated.Text */
  style?: StyleProp<TextStyle>;
  /** Duration in ms (default 800) */
  duration?: number;
  /** Whether to round to integer (default true) */
  round?: boolean;
  /** Format with locale separators (default true) */
  localeFormat?: boolean;
}

/**
 * Animated count-up number display.
 * Springs from 0 (or previous value) to the target value.
 */
export default function AnimatedNumber({
  value,
  prefix = '',
  suffix = '',
  style,
  duration = 800,
  round = true,
  localeFormat = true,
}: AnimatedNumberProps) {
  const animValue = useRef(new Animated.Value(0)).current;
  const [display, setDisplay] = useState(format(0));
  const prevValue = useRef(0);

  function format(n: number): string {
    const num = round ? Math.round(n) : n;
    const formatted = localeFormat ? num.toLocaleString() : String(num);
    return `${prefix}${formatted}${suffix}`;
  }

  useEffect(() => {
    // Listen to animated value changes to update display text
    const id = animValue.addListener(({ value: v }) => {
      setDisplay(format(v));
    });

    // Animate from previous value to new target
    animValue.setValue(prevValue.current);
    Animated.timing(animValue, {
      toValue: value,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // text content requires JS driver
    }).start();

    prevValue.current = value;

    return () => {
      animValue.removeListener(id);
    };
  }, [value]);

  return <Animated.Text style={style}>{display}</Animated.Text>;
}
