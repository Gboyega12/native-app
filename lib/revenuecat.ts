// ── RevenueCat integration ──
// Handles initialization, purchase flow, and entitlement checking.
// Configure these in RevenueCat dashboard:
//   - Entitlement: "pro"
//   - Product IDs: "bocy_pro_monthly" (£4.99/mo), "bocy_pro_annual" (£39.99/yr)
//
// IMPORTANT: react-native-purchases is native-only. We lazy-load it to avoid
// crashing on web where the module doesn't exist.

import { Platform } from 'react-native';

// Lazy-loaded reference — only resolved on native
let Purchases: any = null;
let LOG_LEVEL: any = null;

function loadSDK() {
  if (Platform.OS === 'web') return false;
  if (Purchases) return true;
  try {
    const mod = require('react-native-purchases');
    Purchases = mod.default || mod;
    LOG_LEVEL = mod.LOG_LEVEL;
    return true;
  } catch {
    return false;
  }
}

let _initialized = false;

/** Initialize RevenueCat SDK. Call once at app startup. */
export async function initRevenueCat(userId?: string): Promise<void> {
  if (_initialized) return;
  if (!loadSDK()) {
    _initialized = true;
    return;
  }

  const apiKey = Platform.OS === 'ios'
    ? (process.env.EXPO_PUBLIC_RC_IOS_KEY || '')
    : (process.env.EXPO_PUBLIC_RC_ANDROID_KEY || '');

  if (!apiKey) {
    console.warn('[RevenueCat] No API key configured for', Platform.OS);
    return;
  }

  Purchases.setLogLevel(LOG_LEVEL.WARN);
  Purchases.configure({ apiKey, appUserID: userId || undefined });
  _initialized = true;
}

/** Identify user after auth (links RevenueCat customer to your user ID) */
export async function identifyUser(userId: string): Promise<void> {
  if (!Purchases || !_initialized) return;
  try {
    await Purchases.logIn(userId);
  } catch (err: any) {
    console.warn('[RevenueCat] identify failed:', err?.message);
  }
}

/** Log out on sign-out */
export async function resetUser(): Promise<void> {
  if (!Purchases || !_initialized) return;
  try {
    await Purchases.logOut();
  } catch {}
}

/** Get available offerings (products + prices) */
export async function getOfferings(): Promise<any | null> {
  if (!Purchases || !_initialized) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current;
  } catch (err: any) {
    console.warn('[RevenueCat] getOfferings failed:', err?.message);
    return null;
  }
}

/** Purchase a package (monthly or annual) */
export async function purchasePackage(pkg: any): Promise<{ success: boolean; customerInfo?: any }> {
  if (!Purchases) return { success: false };
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return { success: true, customerInfo };
  } catch (err: any) {
    if (err.userCancelled) return { success: false };
    console.warn('[RevenueCat] purchase failed:', err?.message);
    return { success: false };
  }
}

/** Restore previous purchases */
export async function restorePurchases(): Promise<any | null> {
  if (!Purchases || !_initialized) return null;
  try {
    return await Purchases.restorePurchases();
  } catch (err: any) {
    console.warn('[RevenueCat] restore failed:', err?.message);
    return null;
  }
}

/** Check if user has "pro" entitlement */
export async function checkEntitlement(): Promise<boolean> {
  if (!Purchases || !_initialized) return false;
  try {
    const info = await Purchases.getCustomerInfo();
    return info.entitlements.active['pro'] !== undefined;
  } catch {
    return false;
  }
}

/** Get current customer info */
export async function getCustomerInfo(): Promise<any | null> {
  if (!Purchases || !_initialized) return null;
  try {
    return await Purchases.getCustomerInfo();
  } catch {
    return null;
  }
}
