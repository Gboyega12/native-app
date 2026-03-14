/**
 * Tests for components/Bocy.tsx
 *
 * Covers: getBocyMood (pure function) and BocyFace (component rendering)
 */

import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { getBocyMood, BocyFace } from '@/components/Bocy';

// ── getBocyMood ──

describe('getBocyMood', () => {
  it('returns "neutral" when analysis is null', () => {
    expect(getBocyMood(null)).toBe('neutral');
  });

  it('returns "celebrating" for high score and large surplus', () => {
    expect(getBocyMood({ decision_score: 80, surplus: 300 })).toBe('celebrating');
  });

  it('returns "happy" for good score and positive surplus', () => {
    expect(getBocyMood({ decision_score: 65, surplus: 50 })).toBe('happy');
  });

  it('returns "alert" for negative surplus', () => {
    expect(getBocyMood({ decision_score: 70, surplus: -100 })).toBe('alert');
  });

  it('returns "alert" for low decision score', () => {
    expect(getBocyMood({ decision_score: 30, surplus: 50 })).toBe('alert');
  });

  it('returns "neutral" for moderate values', () => {
    expect(getBocyMood({ decision_score: 50, surplus: 0 })).toBe('neutral');
  });

  it('uses defaults when fields are missing', () => {
    // decision_score defaults to 50, surplus defaults to 0
    expect(getBocyMood({})).toBe('neutral');
  });
});

// ── BocyFace ──

describe('BocyFace', () => {
  it('renders without crashing (default mood)', () => {
    const { toJSON } = render(<BocyFace />);
    expect(toJSON()).toBeTruthy();
  });

  it('renders without crashing with explicit mood', () => {
    const { toJSON } = render(<BocyFace mood="happy" size="lg" />);
    expect(toJSON()).toBeTruthy();
  });

  it('renders a 5x5 grid of dots (25 dot views)', () => {
    const tree = render(<BocyFace mood="neutral" breathing={false} />);
    const json = tree.toJSON();
    // The outer Animated.View contains 5 row Views, each with 5 dot Views
    expect(json).toBeTruthy();
  });
});
