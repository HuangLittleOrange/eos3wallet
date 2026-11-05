import { DEFAULT_CHAIN, type ChainId } from '../chain/config';
import { contentModules } from './modules';
import type { AppBrowseProject, AppContent, ContentItem } from './types';

/** Legacy catalogs describe Vaulta only. Missing scope never means every network. */
export function belongsToNetwork(item: ContentItem, network: ChainId, inherited: ChainId[] = [DEFAULT_CHAIN]) {
  return (item.networkIds ?? inherited).includes(network);
}

export function projectsForNetwork(projects: AppBrowseProject[], network: ChainId): AppBrowseProject[] {
  return projects.flatMap(project => {
    if (project.networkIds && !project.networkIds.includes(network)) return [];
    if (project.networkUrls !== undefined) {
      const appUrl = project.networkUrls[network];
      return appUrl ? [{ ...project, appUrl }] : [];
    }
    return belongsToNetwork(project, network) ? [project] : [];
  });
}

export function discoveryForNetwork(content: AppContent, projects: AppBrowseProject[], network: ChainId) {
  return {
    projects: projectsForNetwork(projects, network),
    content: {
      ...content,
      banners: content.banners.filter(item => belongsToNetwork(item, network)),
      promos: content.promos.filter(item => belongsToNetwork(item, network)),
      earnItems: content.earnItems.filter(item => belongsToNetwork(item, network)),
      // Resolve legacy modules before filtering so [] cannot resurrect mainnet content.
      modules: contentModules(content).filter(module => belongsToNetwork(module, network)).map(module => ({
        ...module,
        items: module.items.filter(item => belongsToNetwork(item, network, module.networkIds ?? [DEFAULT_CHAIN])),
      })),
    },
  };
}
