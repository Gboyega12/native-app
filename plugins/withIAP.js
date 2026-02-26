// Local Expo config plugin — adds billing permission (Android)
// for RevenueCat / StoreKit.
//
// NOTE: The com.apple.developer.in-app-payments entitlement was removed
// because it is for Apple Pay (merchant card processing), NOT for
// StoreKit In-App Purchases. RevenueCat uses StoreKit which is covered
// by the default IAP capability in all App Store provisioning profiles.
// Including the Apple Pay entitlement without the matching capability
// in the provisioning profile causes iOS to kill the app on launch.

const { withAndroidManifest } = require('expo/config-plugins');

function withIAP(config) {
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
