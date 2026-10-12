import defaults from './defaults.json';
import { parseAppContent, parseAppProjects } from './validation';

/** Bundled recovery content is used only until the server has configured a section. */
export const DEFAULT_CONTENT = parseAppContent(defaults.content);
export const DEFAULT_PROJECTS = parseAppProjects(defaults.projects);
