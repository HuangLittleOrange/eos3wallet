import { DEFAULT_CONTENT, DEFAULT_PROJECTS } from '../defaults';
import { localizedText, visibleItems } from '../types';
import { parseAppContent, parseAppContentResponse } from '../validation';

const copy = () => JSON.parse(JSON.stringify(DEFAULT_CONTENT));

it('distinguishes untouched settings from a deliberately empty published catalog', () => {
  expect(parseAppContentResponse({ schemaVersion: 1, content: null, projects: null })).toEqual({ schemaVersion: 1, content: null, projects: null });
  const empty = { ...copy(), intro: null, banners: [], promos: [], earnTitle: {}, earnDescription: {}, earnItems: [], announcements: [], links: [] };
  expect(parseAppContentResponse({ schemaVersion: 1, content: empty, projects: [] }).projects).toEqual([]);
  expect(parseAppContent(empty).banners).toEqual([]);
});

it('accepts the migrated multilingual defaults and a single unified DApp catalog', () => {
  expect(parseAppContentResponse({ schemaVersion: 1, content: DEFAULT_CONTENT, projects: DEFAULT_PROJECTS }).projects).toHaveLength(10);
  expect(new Set(DEFAULT_PROJECTS.map((p) => p.id)).size).toBe(DEFAULT_PROJECTS.length);
  expect(DEFAULT_PROJECTS.find((p) => p.id === 'bloks')?.name).toBe('Bloks');
});

it.each(['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com', 'https://user:password@example.com', 'https://exa\nmple.com', 'https:\\example.com'])('rejects an unsafe operations link %s', (url) => {
  const content = copy(); content.links[0].url = url;
  expect(() => parseAppContent(content)).toThrow();
});

it('rejects unsupported schema, duplicate IDs, unknown locales and malformed dates', () => {
  expect(() => parseAppContent({ ...copy(), schemaVersion: 2 })).toThrow();
  const duplicate = copy(); duplicate.banners.push(duplicate.banners[0]);
  expect(() => parseAppContent(duplicate)).toThrow();
  const locale = copy(); locale.banners[0].title.xx = 'Unknown';
  expect(() => parseAppContent(locale)).toThrow();
  const date = copy(); date.announcements[0].publishedAt = 'not a date';
  expect(() => parseAppContent(date)).toThrow();
});

it('rejects incomplete data rather than silently clearing previously valid content', () => {
  expect(() => parseAppContentResponse({ schemaVersion: 1, content: {}, projects: [] })).toThrow();
  expect(() => parseAppContentResponse({ schemaVersion: 1, content: null })).toThrow();
});

it('uses a nonempty language fallback and preserves explicit visibility and order', () => {
  expect(localizedText({ ja: '', en: 'English', zh: '中文' }, 'ja')).toBe('English');
  const items = [{ id: 'last', enabled: true, sortOrder: 5 }, { id: 'hidden', enabled: false, sortOrder: 0 }, { id: 'first', enabled: true, sortOrder: 1 }];
  expect(visibleItems(items).map((p) => p.id)).toEqual(['first', 'last']);
  expect(items[0].id).toBe('last');
});
