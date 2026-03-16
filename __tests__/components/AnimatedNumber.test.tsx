/**
 * Tests for components/AnimatedNumber.tsx
 *
 * Covers: rendering the target number and currency formatting.
 * Note: AnimatedNumber uses Animated.timing so the displayed value
 * starts at 0 and animates to the target. We test that the component
 * renders without crashing and displays formatted values.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import AnimatedNumber from '@/components/AnimatedNumber';

// Use fake timers to control animations and prevent timer leaks
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  // Flush any pending timers before restoring
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

describe('AnimatedNumber', () => {
  it('renders without crashing', () => {
    const { toJSON } = render(<AnimatedNumber value={100} />);
    expect(toJSON()).toBeTruthy();
  });

  it('displays the initial formatted value (starts at 0)', () => {
    render(<AnimatedNumber value={500} prefix="£" />);
    // The component starts at 0 and animates; initial display is £0
    expect(screen.getByText(/£/)).toBeTruthy();
  });

  it('renders with prefix and suffix', () => {
    render(<AnimatedNumber value={0} prefix="£" suffix="/yr" />);
    expect(screen.getByText('£0/yr')).toBeTruthy();
  });

  it('renders integer by default (round=true)', () => {
    render(<AnimatedNumber value={0} prefix="" suffix="" />);
    expect(screen.getByText('0')).toBeTruthy();
  });
});
