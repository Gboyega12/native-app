/**
 * Tests for components/Card.tsx
 *
 * Covers: Card (default export), AnimatedCard, CardTitle
 */

import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import Card, { AnimatedCard, CardTitle } from '@/components/Card';

// Mock haptics — no native module in test env
jest.mock('@/lib/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticHeavy: jest.fn(),
}));

// ── Card ──

describe('Card', () => {
  it('renders children correctly', () => {
    render(
      <Card>
        <Text>Hello Card</Text>
      </Card>,
    );
    expect(screen.getByText('Hello Card')).toBeTruthy();
  });

  it('passes testID to the underlying View', () => {
    render(
      <Card testID="my-card">
        <Text>Content</Text>
      </Card>,
    );
    expect(screen.getByTestId('my-card')).toBeTruthy();
  });

  it('renders as Pressable when onPress is provided', () => {
    const onPress = jest.fn();
    render(
      <Card testID="pressable-card" onPress={onPress as any}>
        <Text>Pressable</Text>
      </Card>,
    );
    expect(screen.getByTestId('pressable-card')).toBeTruthy();
    expect(screen.getByText('Pressable')).toBeTruthy();
  });
});

// ── CardTitle ──

describe('CardTitle', () => {
  it('renders text content', () => {
    render(<CardTitle>BUDGET</CardTitle>);
    expect(screen.getByText('BUDGET')).toBeTruthy();
  });
});

// ── AnimatedCard ──

describe('AnimatedCard', () => {
  it('renders children inside an animated wrapper', () => {
    render(
      <AnimatedCard>
        <Text>Animated Content</Text>
      </AnimatedCard>,
    );
    expect(screen.getByText('Animated Content')).toBeTruthy();
  });
});
