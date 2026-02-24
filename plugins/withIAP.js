// Local Expo config plugin — adds In-App Purchase entitlement (iOS)
// and billing permission (Android) for RevenueCat / StoreKit.

const { withEntitlementsPlist, withAndroidManifest } = require('expo/config-plugins');

function withIAP(config) {
  // iOS: add com.apple.developer.in-app-payments entitlement
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.developer.in-app-payments'] =
      mod.modResults['com.apple.developer.in-app-payments'] || ['*'];
    return mod;
  });

  // Android: add BILLING permission
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const permissions = manifest['uses-permission'] || [];
    const billing = 'com.android.vending.BILLING';
    if (!permissions.some((p) => p.$?.['android:name'] === billing)) {
      permissions.push({ $: { 'android:name': billing } });
    }
    manifest['uses-permission'] = permissions;
    return mod;
  });

  return config;
}

module.exports = withIAP;
