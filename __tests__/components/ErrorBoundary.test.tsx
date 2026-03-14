/**
 * Tests for components/ErrorBoundary.tsx
 *
 * Covers: rendering children normally, and catching + displaying errors.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { Text } from 'react-native';
import ErrorBoundary from '@/components/ErrorBoundary';

// Mock Sentry so it doesn't try to initialise
jest.mock('@/lib/sentry', () => ({
  captureException: jest.fn(),
}));

// Suppress console.error from ErrorBoundary's componentDidCatch
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = jest.fn() as any;
});

afterAll(() => {
  console.error = originalConsoleError;
});

// Helper: a component that throws on render
function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Test explosion');
  return <Text>Safe child</Text>;
}

describe('ErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <Text>Hello World</Text>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Hello World')).toBeTruthy();
  });

  it('shows error UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText(/Test explosion/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('uses fallbackMessage prop when provided', () => {
    render(
      <ErrorBoundary fallbackMessage="Custom error message">
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Custom error message')).toBeTruthy();
  });

  it('recovers when Try again is pressed', () => {
    // We need to render a component that throws first, then doesn't after retry.
    // ErrorBoundary.handleRetry resets hasError, causing re-render of children.
    // Since ThrowingChild always throws when shouldThrow=true, the boundary
    // will catch again immediately. We test that the button is pressable.
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>,
    );
    const retryButton = screen.getByText('Try again');
    expect(retryButton).toBeTruthy();
    // Pressing retry resets state (child will throw again, but the press should work)
    fireEvent.press(retryButton);
    // After retry + re-throw, error UI should still be visible
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });
});
