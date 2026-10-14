import type { LocaleId } from '../i18n';

export type LocalizedText = Partial<Record<LocaleId, string>>;

export type ContentItem = { id: string; enabled: boolean; sortOrder: number };
export type ContentBanner = ContentItem & {
  imageUrl?: string;
  url?: string;
};
export type ContentPromo = ContentItem & {
  title: LocalizedText;
  colors: [string, string];
  imageUrl?: string;
  url?: string;
};
export type ContentEarnItem = ContentItem & {
  title: LocalizedText;
  description: LocalizedText;
  color: string;
  hot: boolean;
  imageUrl?: string;
  url?: string;
};
export type ContentAnnouncement = ContentItem & {
  title: LocalizedText;
  body: LocalizedText;
  publishedAt: string;
  url?: string;
};
export type ContentLink = ContentItem & { title: LocalizedText; url: string };

/** Operations may edit text and links; signing rules and contract addresses stay local. */
export type AppContent = {
  schemaVersion: 1;
  intro: { title: LocalizedText; subtitle: LocalizedText } | null;
  banners: ContentBanner[];
  promos: ContentPromo[];
  earnEnabled?: boolean;
  earnTitle: LocalizedText;
  earnDescription: LocalizedText;
  earnItems: ContentEarnItem[];
  announcements: ContentAnnouncement[];
  links: ContentLink[];
};

export type AppBrowseProject = ContentItem & {
  name: string;
  description: string;
  iconUrl: string;
  appUrl: string;
  category: string;
  featured: boolean;
  color?: string;
  letter?: string;
  translations?: Partial<Record<LocaleId, { name?: string; description?: string; category?: string }>>;
};

/** null = never configured; [] = deliberately published an empty catalog. */
export type AppContentResponse = {
  schemaVersion: 1;
  content: AppContent | null;
  projects: AppBrowseProject[] | null;
};

export function localizedText(value: LocalizedText, locale: LocaleId): string {
  return [value[locale], value.en, value.zh, ...Object.values(value)].find((text) => text?.trim()) ?? '';
}

export function visibleItems<T extends ContentItem>(items: T[]): T[] {
  return items.filter((item) => item.enabled).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}
