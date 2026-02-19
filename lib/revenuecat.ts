// ── RevenueCat integration ──
// Handles initialization, purchase flow, and entitlement checking.
// Configure these in RevenueCat dashboard:
//   - Entitlement: "pro"
//   - Product IDs: "bocy_pro_monthly" (£4.99/mo), "bocy_pro_annual" (£39.99/yr)

import { Platform } from 'react-native';
import Purchases, {
  PurchasesOffering,
  PurchasesPackage,
  CustomerInfo,
  LOG_LEVEL,
} from 'react-native-purchases';

const API_KEY_IOS = process.env.EXPO_PUBLIC_RC_IOS_KEY || '';
const API_KEY_ANDROID = process.env.EXPO_PUBLIC_RC_ANDROID_KEY || '';
const API_KEY_WEB = process.env.EXPO_PUBLIC_RC_WEB_KEY || ''; // For web billing (if enabled)

let _initialized = false;

/** Initialize RevenueCat SDK. Call once at app startup. */
export async function initRevenueCat(userId?: string): Promise<void> {
  if (_initialized) return;
  if (Platform.OS === 'web') {
    // RevenueCat doesn't support web natively — web purchases handled via Stripe
    // through the webhook. We still track entitlements via Supabase.
    _initialized = true;
    return;
  }

  const apiKey = Platform.OS === 'ios' ? API_KEY_IOS : API_KEY_ANDROID;
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
  if (Platform.OS === 'web' || !_initialized) return;
  try {
    await Purchases.logIn(userId);
  } catch (err: any) {
    console.warn('[RevenueCat] identify failed:', err?.message);
  }
}

/** Log out on sign-out */
export async function resetUser(): Promise<void> {
  if (Platform.OS === 'web' || !_initialized) return;
  try {
    await Purchases.logOut();
  } catch {}
}

/** Get available offerings (products + prices) */
export async function getOfferings(): Promise<PurchasesOffering | null> {
  if (Platform.OS === 'web' || !_initialized) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current;
  } catch (err: any) {
    console.warn('[RevenueCat] getOfferings failed:', err?.message);
    return null;
  }
}

/** Purchase a package (monthly or annual) */
export async function purchasePackage(pkg: PurchasesPackage): Promise<{ success: boolean; customerInfo?: CustomerInfo }> {
  if (Platform.OS === 'web') {
    return { success: false };
  }
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return { success: true, customerInfo };
  } catch (err: any) {
    if (err.userCancelled) {
      return { success: false };
    }
    console.warn('[RevenueCat] purchase failed:', err?.message);
    return { success: false };
  }
}

/** Restore previous purchases */
export async function restorePurchases(): Promise<CustomerInfo | null> {
  if (Platform.OS === 'web' || !_initialized) return null;
  try {
    const info = await Purchases.restorePurchases();
    return info;
  } catch (err: any) {
    console.warn('[RevenueCat] restore failed:', err?.message);
    return null;
  }
}

/** Check if user has "pro" entitlement */
export async function checkEntitlement(): Promise<boolean> {
  if (Platform.OS === 'web' || !_initialized) return false;
  try {
    const info = await Purchases.getCustomerInfo();
    return info.entitlements.active['pro'] !== undefined;
  } catch {
    return false;
  }
}

/** Get current customer info */
export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (Platform.OS === 'web' || !_initialized) return null;
  try {
    return await Purchases.getCustomerInfo();
  } catch {
    return null;
  }
}
