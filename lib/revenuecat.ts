// ── RevenueCat IAP helpers ──
// Wraps react-native-purchases for iOS/Android in-app subscriptions.
// Web uses Stripe Checkout (unchanged). This module is only imported on native.

import { Platform } from 'react-native';
import Purchases, {
  type PurchasesOffering,
  type CustomerInfo,
  LOG_LEVEL,
} from 'react-native-purchases';

// RevenueCat API keys — set these in your environment or hardcode for now.
// You get these from the RevenueCat dashboard under Project > API Keys.
const RC_IOS_KEY = process.env.EXPO_PUBLIC_RC_IOS_KEY ?? '';
const RC_ANDROID_KEY = process.env.EXPO_PUBLIC_RC_ANDROID_KEY ?? '';

// The entitlement identifier you create in RevenueCat dashboard.
// Must match exactly (e.g. "pro" in RevenueCat > Entitlements).
const ENTITLEMENT_ID = 'pro';

let _initialised = false;

/**
 * Initialise RevenueCat SDK. Call once on app boot (native only).
 * Pass the Supabase user ID as the app user ID so purchases map to your DB.
 */
export async function initRevenueCat(supabaseUserId: string): Promise<void> {
  if (Platform.OS === 'web' || _initialised) return;

  const apiKey = Platform.OS === 'ios' ? RC_IOS_KEY : RC_ANDROID_KEY;
  if (!apiKey) {
    console.warn('[RevenueCat] No API key for platform:', Platform.OS);
    return;
  }

  if (__DEV__) {
    Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  }

  Purchases.configure({ apiKey, appUserID: supabaseUserId });
  _initialised = true;
}

/**
 * Fetch available offerings (product listings from App Store / Play Store).
 * Returns the "default" offering, or null if none configured.
 */
export async function getOffering(): Promise<PurchasesOffering | null> {
  if (Platform.OS === 'web') return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current ?? null;
  } catch (err) {
    console.warn('[RevenueCat] getOfferings error:', err);
    return null;
  }
}

/**
 * Purchase a package (monthly or yearly) via native IAP.
 * Returns the updated CustomerInfo on success, or null on cancel/error.
 */
export async function purchasePackage(
  packageId: 'monthly' | 'yearly',
): Promise<CustomerInfo | null> {
  if (Platform.OS === 'web') return null;

  const offering = await getOffering();
  if (!offering) throw new Error('No offerings available');

  // RevenueCat package identifiers: "$rc_monthly", "$rc_annual"
  const rcId = packageId === 'yearly' ? '$rc_annual' : '$rc_monthly';
  const pkg = offering.availablePackages.find((p) => p.identifier === rcId);
  if (!pkg) throw new Error(`Package "${rcId}" not found in offering`);

  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return customerInfo;
  } catch (err: any) {
    // User cancelled — not an error
    if (err.userCancelled) return null;
    throw err;
  }
}

/**
 * Restore previous purchases (e.g. after reinstall or new device).
 * Returns true if the user has an active "pro" entitlement after restore.
 */
export async function restorePurchases(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const customerInfo = await Purchases.restorePurchases();
    return hasProEntitlement(customerInfo);
  } catch (err) {
    console.warn('[RevenueCat] restore error:', err);
    return false;
  }
}

/**
 * Check if CustomerInfo has an active "pro" entitlement.
 */
export function hasProEntitlement(info: CustomerInfo): boolean {
  return info.entitlements.active[ENTITLEMENT_ID] !== undefined;
}
