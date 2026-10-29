import { afterEach, describe, expect, it, vi } from 'vitest';
import { categoryClass, compactNumber, dateLabel, offerState, relativeDate } from '../src/lib/display';

afterEach(() => vi.useRealTimers());
describe('wall display helpers', () => {
  it('formats dates consistently in UTC', () => {
    expect(dateLabel('2026-10-28T23:30:00Z')).toBe('Oct 28');
    expect(dateLabel('2026-10-28T23:30:00Z', true)).toBe('October 28, 2026');
    expect(dateLabel(null)).toBe('Not yet');
  });
  it('handles dates relative to the present', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    expect(relativeDate('2026-10-28T01:00:00Z')).toBe('Today');
    expect(relativeDate('2026-10-27T12:00:00Z')).toBe('Yesterday');
    expect(relativeDate('2026-10-25T12:00:00Z')).toBe('3 days ago');
    expect(relativeDate(null)).toBe('');
  });
  it('switches offer states at the exact start and end times', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    expect(offerState('2026-10-28T12:00:01Z', null)).toBe('Upcoming');
    expect(offerState('2026-10-28T12:00:00Z', '2026-10-29T12:00:00Z')).toBe('Active');
    expect(offerState(null, '2026-10-28T12:00:00Z')).toBe('Expired');
    expect(offerState(null, null)).toBe('Active');
  });
  it('maps category names to class-safe values', () => {
    expect(categoryClass('AI & tech')).toBe('ai');
    expect(categoryClass('Apps')).toBe('apps');
  });
  it('formats genuine counts without padding or invented values', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(8)).toBe('8');
    expect(compactNumber(1500)).toBe('1.5K');
  });
});
