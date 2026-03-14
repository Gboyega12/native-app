/**
 * Tests for components/Skeleton.tsx
 *
 * Covers: DashboardSkeleton, HeroCardSkeleton, MoveCardSkeleton
 */

import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { DashboardSkeleton, HeroCardSkeleton, MoveCardSkeleton } from '@/components/Skeleton';

describe('DashboardSkeleton', () => {
  it('renders without crashing', () => {
    const { toJSON } = render(<DashboardSkeleton />);
    expect(toJSON()).toBeTruthy();
  });

  it('renders hero and move card skeletons (1 hero + 3 moves = multiple children)', () => {
    const tree = render(<DashboardSkeleton />);
    const json = tree.toJSON();
    // DashboardSkeleton renders a View with 4 children (1 HeroCard + 3 MoveCards)
    expect(json).toBeTruthy();
    // The root is a View containing child Views
    if (json && !Array.isArray(json)) {
      expect(json.children).toBeTruthy();
      expect(json.children!.length).toBe(4);
    }
  });
});

describe('HeroCardSkeleton', () => {
  it('renders without crashing', () => {
    const { toJSON } = render(<HeroCardSkeleton />);
    expect(toJSON()).toBeTruthy();
  });
});

describe('MoveCardSkeleton', () => {
  it('renders without crashing', () => {
    const { toJSON } = render(<MoveCardSkeleton />);
    expect(toJSON()).toBeTruthy();
  });
});
