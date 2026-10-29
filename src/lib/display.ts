export const categories = ['AI & tech', 'Apps', 'Games', 'Offers', 'Thoughts'] as const;
export const categoryIcons: Record<string, string> = { 'AI & tech': 'spark', Apps: 'app', Games: 'game', Offers: 'tag', Thoughts: 'thought' };
export const categoryClass = (category: string) => category === 'AI & tech' ? 'ai' : category.toLowerCase();
export function dateLabel(value: string | null, long = false) {
  if (!value) return 'Not yet';
  return new Intl.DateTimeFormat('en', { month: long ? 'long' : 'short', day: 'numeric', ...(long ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(value));
}
export function relativeDate(value: string | null) {
  if (!value) return '';
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return dateLabel(value);
}
export function offerState(start: string | null, end: string | null) {
  if (start && new Date(start).getTime() > Date.now()) return 'Upcoming';
  if (end && new Date(end).getTime() <= Date.now()) return 'Expired';
  return 'Active';
}
export const compactNumber = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
