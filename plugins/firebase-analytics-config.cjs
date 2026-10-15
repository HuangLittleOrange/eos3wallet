'use strict';
const fs = require('node:fs');
const path = require('node:path');

const AD_PERMISSIONS = [
  'com.google.android.gms.permission.AD_ID',
  'android.permission.ACCESS_ADSERVICES_AD_ID',
  'android.permission.ACCESS_ADSERVICES_ATTRIBUTION',
  'android.permission.ACCESS_ADSERVICES_TOPICS',
];
function serviceFile(root, configured, fallback) {
  const file = configured || fallback;
  const absolute = path.resolve(root, file);
  if (!fs.existsSync(absolute)) {
    if (configured) throw new Error('Firebase configuration file is missing; check its configured local path.');
    return undefined;
  }
  if (fs.statSync(absolute).size > 1024 * 1024) throw new Error('Firebase app configuration is too large.');
  return file;
}
function configureFirebase(config, root, env = process.env) {
  const androidFile = serviceFile(root, env.GOOGLE_SERVICES_JSON || config.android?.googleServicesFile, 'firebase/google-services.json');
  const iosFile = serviceFile(root, env.GOOGLE_SERVICE_INFO_PLIST || config.ios?.googleServicesFile, 'firebase/GoogleService-Info.plist');
  let androidProject, iosProject;
  if (androidFile) {
    const data = JSON.parse(fs.readFileSync(path.resolve(root, androidFile), 'utf8'));
    if (data.type === 'service_account' || data.private_key || !data.project_info?.project_id ||
        !data.client?.some(client => client.client_info?.android_client_info?.package_name === config.android?.package && client.client_info?.mobilesdk_app_id)) {
      throw new Error('Firebase Android app configuration must match the Android package; service account keys are not accepted.');
    }
    androidProject = data.project_info.project_id;
  }
  if (iosFile) {
    const data = require('@expo/plist').default.parse(fs.readFileSync(path.resolve(root, iosFile), 'utf8'));
    if (data.BUNDLE_ID !== config.ios?.bundleIdentifier || !data.GOOGLE_APP_ID || !data.PROJECT_ID) {
      throw new Error('Firebase iOS app configuration must match the iOS bundle identifier.');
    }
    iosProject = data.PROJECT_ID;
  }
  if (androidProject && iosProject && androidProject !== iosProject) throw new Error('Both Firebase apps must belong to the same project.');
  const removed = new Set(['@react-native-firebase/app', '@react-native-firebase/analytics', './plugins/with-firebase-analytics.cjs']);
  const plugins = (config.plugins || []).filter(plugin => !removed.has(Array.isArray(plugin) ? plugin[0] : plugin));
  const buildProperties = plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-build-properties');
  const iosProperties = { ...(buildProperties?.[1]?.ios || {}), useFrameworks: 'dynamic' };
  const linkedPlugins = plugins.filter(plugin => (Array.isArray(plugin) ? plugin[0] : plugin) !== 'expo-build-properties');
  linkedPlugins.push(['expo-build-properties', { ...(buildProperties?.[1] || {}), ios: iosProperties }]);
  return {
    ...config,
    android: { ...config.android, ...(androidFile ? { googleServicesFile: androidFile } : {}),
      blockedPermissions: [...new Set([...(config.android?.blockedPermissions || []), ...AD_PERMISSIONS])] },
    ios: { ...config.ios, ...(iosFile ? { googleServicesFile: iosFile } : {}), infoPlist: {
      ...config.ios?.infoPlist,
      FirebaseAutomaticScreenReportingEnabled: false,
      FIREBASE_ANALYTICS_COLLECTION_ENABLED: false,
      GOOGLE_ANALYTICS_IDFV_COLLECTION_ENABLED: false,
      GOOGLE_ANALYTICS_DEFAULT_ALLOW_ANALYTICS_STORAGE: false,
      GOOGLE_ANALYTICS_DEFAULT_ALLOW_AD_STORAGE: false,
      GOOGLE_ANALYTICS_DEFAULT_ALLOW_AD_USER_DATA: false,
      GOOGLE_ANALYTICS_DEFAULT_ALLOW_AD_PERSONALIZATION_SIGNALS: false,
      GOOGLE_ANALYTICS_REGISTRATION_WITH_AD_NETWORK_ENABLED: false,
    } },
    extra: { ...config.extra, firebaseAnalytics: { android: Boolean(androidFile), ios: Boolean(iosFile) } },
    plugins: [...linkedPlugins,
      // Always exclude iOS advertising pods, including unconfigured builds.
      ['@react-native-firebase/analytics', { ios: { withoutAdIdSupport: true, googleAppMeasurementOnDeviceConversion: false } }],
      ['./plugins/with-firebase-analytics.cjs', { android: Boolean(androidFile), ios: Boolean(iosFile) }]],
  };
}
module.exports = { configureFirebase, AD_PERMISSIONS };
