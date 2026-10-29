import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { PostFormat } from './types';

const allowedTags = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
  'ul', 'ol', 'li', 'blockquote', 'strong', 'b', 'em', 'i', 's', 'del',
  'code', 'pre', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'th', 'td', 'caption', 'details', 'summary', 'sup', 'sub',
];

/** The sole rendering boundary for both authored HTML and Markdown. */
export function renderContent(body: string, format: PostFormat): string {
  const html = format === 'markdown' ? marked.parse(body, { async: false, gfm: true }) : body;
  return sanitizeHtml(html, {
    allowedTags,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      code: ['class'],
      ol: ['start'],
      th: ['colspan', 'rowspan', 'scope'],
      td: ['colspan', 'rowspan'],
      details: ['open'],
    },
    allowedClasses: { code: ['language-*'] },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { img: ['http', 'https'], a: ['http', 'https', 'mailto'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, target: '_blank', rel: 'noreferrer noopener' } }),
      img: (_tag, attrs) => ({ tagName: 'img', attribs: { ...attrs, loading: 'lazy' } }),
    },
  });
}

export function deriveExcerpt(body: string, format: PostFormat): string {
  // textFilter receives escaped text, without markup. Never render this as HTML.
  const text: string[] = [];
  sanitizeHtml(renderContent(body, format), {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (part) => { text.push(part); return ''; },
  });
  return text.join(' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim().slice(0, 500);
}
