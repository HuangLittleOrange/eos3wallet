import type { AppBrowseProject, AppContent, AppContentResponse, ContentItem, LocalizedText } from './types';

const LOCALES = new Set(['zh', 'en', 'ja', 'ko', 'vi', 'ru']);
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function invalid(): never { throw new Error('Invalid app content response'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, required = false): string {
  if (typeof value !== 'string' || [...value].length > limit || (required && !value.trim())) invalid();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function localized(value: unknown, limit: number, required = true): LocalizedText {
  const fields = record(value);
  const result: LocalizedText = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (!LOCALES.has(key)) invalid();
    result[key as keyof LocalizedText] = text(raw, limit);
  }
  if (required && !Object.values(result).some((v) => v?.trim())) invalid();
  return result;
}
function color(value: unknown): string {
  const result = text(value, 9);
  if (!COLOR.test(result)) invalid();
  return result;
}
function colors(value: unknown): [string, string] {
  if (!Array.isArray(value) || value.length !== 2) invalid();
  return [color(value[0]), color(value[1])];
}
function url(value: unknown, http = false): string {
  const result = text(value, 2048, true);
  let parsed: URL;
  try { parsed = new URL(result); } catch { return invalid(); }
  if ((!http && parsed.protocol !== 'https:') || (http && !['https:', 'http:'].includes(parsed.protocol)) ||
      !parsed.hostname || parsed.username || parsed.password || /[\\\p{Cc}\s]/u.test(result)) invalid();
  return result;
}
function optionalURL(value: unknown): string | undefined {
  return value === undefined || value === '' ? undefined : url(value);
}
function item(value: Record<string, unknown>): ContentItem {
  const id = text(value.id, 80, true);
  if (id !== id.trim() || !Number.isInteger(value.sortOrder) || Math.abs(Number(value.sortOrder)) > 1_000_000) invalid();
  return { id, sortOrder: value.sortOrder as number, enabled: boolean(value.enabled) };
}
function items<T extends ContentItem>(value: unknown, parse: (raw: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value) || value.length > 100) invalid();
  const parsed = value.map((entry) => parse(record(entry)));
  if (new Set(parsed.map((entry) => entry.id)).size !== parsed.length) invalid();
  return parsed;
}

export function parseAppContent(value: unknown): AppContent {
  const raw = record(value);
  if (raw.schemaVersion !== 1) invalid();
  const intro = raw.intro === null ? null : record(raw.intro);
  const earnEnabled = raw.earnEnabled === undefined ? true : boolean(raw.earnEnabled);
  const earnItems = items(raw.earnItems, (e) => ({ ...item(e), title: localized(e.title, 200),
    description: localized(e.description, 2000), color: color(e.color), hot: boolean(e.hot),
    imageUrl: optionalURL(e.imageUrl), url: optionalURL(e.url) }));
  return {
    schemaVersion: 1,
    intro: intro ? { title: localized(intro.title, 200), subtitle: localized(intro.subtitle, 2000) } : null,
    banners: items(raw.banners, (b) => {
      // Older documents may still contain text and gradient fields; only the image is displayed.
      return { ...item(b), imageUrl: optionalURL(b.imageUrl), url: optionalURL(b.url) };
    }),
    promos: items(raw.promos, (p) => ({ ...item(p), title: localized(p.title, 200), colors: colors(p.colors),
      imageUrl: optionalURL(p.imageUrl), url: optionalURL(p.url) })),
    modules: raw.modules === undefined ? undefined : items(raw.modules, (m) => {
      const entries = items(m.items, (e) => {
        const projectId = e.projectId === undefined || e.projectId === '' ? undefined : text(e.projectId, 80, true);
        return { ...item(e), projectId, title: localized(e.title, 200, !projectId),
          description: localized(e.description, 2000, false), color: color(e.color), hot: boolean(e.hot),
          imageUrl: optionalURL(e.imageUrl), url: optionalURL(e.url) };
      });
      const refs = entries.flatMap((e) => e.projectId ? [e.projectId] : []);
      if (new Set(refs).size !== refs.length) invalid();
      return { ...item(m), title: localized(m.title, 200), description: localized(m.description, 2000, false), items: entries };
    }),
    earnEnabled,
    earnTitle: localized(raw.earnTitle, 200, earnEnabled && earnItems.some((item) => item.enabled)),
    earnDescription: localized(raw.earnDescription, 2000, false),
    earnItems,
    announcements: items(raw.announcements, (a) => {
      const publishedAt = text(a.publishedAt, 64, true);
      if (!Number.isFinite(Date.parse(publishedAt))) invalid();
      return { ...item(a), title: localized(a.title, 200), body: localized(a.body, 10000), publishedAt, url: optionalURL(a.url) };
    }),
    links: items(raw.links, (l) => ({ ...item(l), title: localized(l.title, 200), url: url(l.url) })),
  };
}

export function parseAppProjects(value: unknown): AppBrowseProject[] {
  return items(value, (p) => {
    const translations: AppBrowseProject['translations'] = {};
    if (p.translations !== undefined && p.translations !== null) {
      for (const [locale, entry] of Object.entries(record(p.translations))) {
        if (!LOCALES.has(locale)) invalid();
        const fields = record(entry);
        const translated: { name?: string; description?: string; category?: string } = {};
        for (const key of ['name', 'description', 'category'] as const) {
          if (fields[key] !== undefined) translated[key] = text(fields[key], key === 'description' ? 500 : key === 'category' ? 40 : 80);
        }
        translations[locale as keyof typeof translations] = translated;
      }
    }
    return { ...item(p), name: text(p.name, 80, true), description: text(p.description, 500),
      category: text(p.category, 40), appUrl: url(p.appUrl, true),
      iconUrl: p.iconUrl === '' ? '' : url(p.iconUrl, true), featured: boolean(p.featured),
      color: p.color === undefined || p.color === '' ? undefined : color(p.color),
      letter: p.letter === undefined || p.letter === '' ? undefined : text(p.letter, 8), translations };
  });
}

export function parseAppContentResponse(value: unknown): AppContentResponse {
  const raw = record(value);
  if (raw.schemaVersion !== 1) invalid();
  return { schemaVersion: 1, content: raw.content === null ? null : parseAppContent(raw.content),
    projects: raw.projects === null ? null : parseAppProjects(raw.projects) };
}
