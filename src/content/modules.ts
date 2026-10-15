import { localizedText, visibleItems, type AppContent, type AppBrowseProject, type ContentModule } from './types';
import type { LocaleId } from '../i18n';

/** Only absent modules use the legacy document. An explicit empty list stays empty. */
export function contentModules(content: AppContent): ContentModule[] {
  return content.modules ?? [{ id: 'legacy-earn', enabled: content.earnEnabled !== false, sortOrder: 0,
    title: content.earnTitle, description: content.earnDescription, items: content.earnItems }];
}
export function discoveryModules(content: AppContent, projects: AppBrowseProject[], locale: LocaleId) {
  const catalog = new Map(projects.map((project) => [project.id, project]));
  return visibleItems(contentModules(content)).map((module) => ({
    id: module.id, title: localizedText(module.title, locale), description: localizedText(module.description, locale),
    items: visibleItems(module.items).flatMap((item) => {
      if (item.projectId) {
        const project = catalog.get(item.projectId);
        if (!project?.enabled) return [];
        return [{ ...item, name: project.translations?.[locale]?.name || project.name,
          desc: project.translations?.[locale]?.description || project.description,
          imageUrl: project.iconUrl, url: project.appUrl, color: project.color || '#1677ff' }];
      }
      return [{ ...item, name: localizedText(item.title, locale), desc: localizedText(item.description, locale) }];
    }),
  })).filter((module) => module.items.length > 0);
}
