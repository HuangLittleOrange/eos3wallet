import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {configureFirebase,AD_PERMISSIONS}=require('../../plugins/firebase-analytics-config.cjs');
const withFirebase=require('../../plugins/with-firebase-analytics.cjs');
const plist=require('@expo/plist').default;
const root=path.resolve(import.meta.dirname,'../..');
const config=()=>JSON.parse(fs.readFileSync(path.join(root,'app.json'))).expo;
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eos3-firebase-test-'));fs.mkdirSync(path.join(dir,'firebase'));return dir;}
function android(dir,packageName='com.eos3.wallet',project='demo-eos3'){
 fs.writeFileSync(path.join(dir,'firebase/google-services.json'),JSON.stringify({project_info:{project_id:project},client:[{client_info:{android_client_info:{package_name:packageName},mobilesdk_app_id:'1:123:android:abc'}}]}));
}
function ios(dir,project='demo-eos3'){
 fs.writeFileSync(path.join(dir,'firebase/GoogleService-Info.plist'),plist.build({BUNDLE_ID:'com.eos3.wallet',GOOGLE_APP_ID:'1:123:ios:def',PROJECT_ID:project}));
}
test('unconfigured native platforms stay disabled while advertising permissions and iOS ad pods are excluded',()=>{
 const dir=fixture();try{
  const original=config(),result=configureFirebase(original,dir,{});
  assert.deepEqual(result.extra.firebaseAnalytics,{android:false,ios:false});
  for(const permission of AD_PERMISSIONS)assert.ok(result.android.blockedPermissions.includes(permission));
  assert.equal(result.version,original.version);assert.equal(result.android.versionCode,original.android.versionCode);
  assert.equal(result.ios.infoPlist.FIREBASE_ANALYTICS_COLLECTION_ENABLED,false);
  assert.equal(result.ios.infoPlist.GOOGLE_ANALYTICS_DEFAULT_ALLOW_AD_USER_DATA,false);
  assert.deepEqual(result.plugins.find(p=>p[0]==='@react-native-firebase/analytics')[1].ios,{withoutAdIdSupport:true,googleAppMeasurementOnDeviceConversion:false});
  assert.equal(result.plugins.find(p=>p[0]==='expo-build-properties')[1].ios.useFrameworks,'dynamic');
  assert.equal(original.plugins.find(p=>p[0]==='expo-build-properties')[1].ios.useFrameworks,undefined);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('validates both app identifiers and project identity without leaking SDK configuration to JS',()=>{
 const dir=fixture();try{
  android(dir);ios(dir);const result=configureFirebase(config(),dir,{});
  assert.deepEqual(result.extra.firebaseAnalytics,{android:true,ios:true});
  assert.ok(!JSON.stringify(result.extra).includes('demo-eos3'));
  android(dir,'wrong.package');assert.throws(()=>configureFirebase(config(),dir,{}),/must match/);
  android(dir);ios(dir,'other-project');assert.throws(()=>configureFirebase(config(),dir,{}),/same project/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('rejects private service accounts and explicitly missing files',()=>{
 const dir=fixture();try{
  assert.throws(()=>configureFirebase(config(),dir,{GOOGLE_SERVICES_JSON:'missing.json'}),/missing/);
  fs.writeFileSync(path.join(dir,'firebase/google-services.json'),JSON.stringify({type:'service_account',private_key:'DO_NOT_UPLOAD'}));
  assert.throws(()=>configureFirebase(config(),dir,{}),/service account keys are not accepted/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('one configured platform keeps existing mods on the other platform intact',()=>{
 const originalIos={test:async x=>x},originalAndroid={test:async x=>x};
 const base={...config(),_internal:{projectRoot:root},mods:{ios:originalIos,android:originalAndroid}};
 assert.equal(withFirebase(base,{ios:false,android:false}),base);
 const androidOnly=withFirebase({...base,_internal:{projectRoot:root}},{ios:false,android:true});assert.equal(androidOnly.mods.ios,originalIos);assert.ok(androidOnly.mods.android.dangerous);
 const iosOnly=withFirebase({...base,_internal:{projectRoot:root}},{ios:true,android:false});assert.equal(iosOnly.mods.android,originalAndroid);assert.ok(iosOnly.mods.ios.dangerous);
});
test('firebase.json uses recognized false defaults for all advertising and automatic screen collection',()=>{
 const actual=JSON.parse(fs.readFileSync(path.join(root,'firebase.json')))['react-native'];
 const schema=JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('@react-native-firebase/app/package.json')),'firebase-schema.json'))).properties['react-native'].properties;
 for(const [key,value] of Object.entries(actual)){assert.ok(schema[key],key);assert.equal(value,false,key);}
});
test('the official Analytics plugin generates the no-ad-ID pod flag without conversion measurement',()=>{
 const official=require(path.join(path.dirname(require.resolve('@react-native-firebase/analytics/package.json')),'plugin/build/ios/podfile.js'));
 const source="platform :ios, '16.4'\nprepare_react_native_project!\n";
 const result=official.setAnalyticsPodfileWithoutAdIdSupport(source,true);
 assert.match(result,/\$RNFirebaseAnalyticsWithoutAdIdSupport = true/);
 assert.doesNotMatch(result,/GoogleAppMeasurementOnDeviceConversion = true/);
 assert.equal(official.setAnalyticsPodfileWithoutAdIdSupport(result,true),result);
});
