export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ADMIN_PASSWORD: string;
  AGENT_TOKEN: string;
  SESSION_SECRET: string;
}

export const CATEGORIES = ['AI & tech', 'Apps', 'Games', 'Offers', 'Thoughts'] as const;
export const FORMATS = ['markdown', 'html'] as const;
export const STATUSES = ['draft', 'published', 'scheduled', 'archived'] as const;
export type Category = (typeof CATEGORIES)[number];
export type PostFormat = (typeof FORMATS)[number];
export type PostStatus = (typeof STATUSES)[number];

export interface Post {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  format: PostFormat;
  category: Category;
  tags: string[];
  cover_image: string | null;
  link_url: string | null;
  link_label: string | null;
  invite_code: string | null;
  offer_start: string | null;
  offer_end: string | null;
  status: PostStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  pinned: boolean;
}

export type PostInput = Pick<Post, 'title' | 'body'> &
  Partial<Omit<Post, 'id' | 'title' | 'body' | 'created_at' | 'updated_at'>>;
export type ValidatedPost = Omit<Post, 'id' | 'created_at' | 'updated_at'>;
export interface PostQuery {
  category?: string;
  q?: string;
  tag?: string;
  sort?: string;
  page?: number;
  limit?: number;
  studio?: boolean;
  status?: string;
}
export interface PostsResult {
  posts: Post[];
  total: number;
  page: number;
  pages: number;
}
export interface Settings {
  site_name: string;
  tagline: string;
  description: string;
  author_name: string;
  author_bio: string;
  launch_date: string;
  github_url: string;
  contact_url: string;
}
export interface Stats {
  posts: number;
  visits: number;
  started_at: string;
  last_updated: string | null;
  categories: { category: string; count: number }[];
}
