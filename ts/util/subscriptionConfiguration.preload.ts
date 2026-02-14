// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { pickBy } from 'lodash';
import { HTTPError } from '../types/HTTPError.std.js';
import type { SubscriptionConfigurationResultType } from '../textsecure/WebAPI.preload.js';
import { getSubscriptionConfiguration } from '../textsecure/WebAPI.preload.js';
import {
  PaymentMethod,
  type OneTimeDonationHumanAmounts,
} from '../types/Donations.std.js';
import { HOUR } from './durations/index.std.js';
import { isInPast } from './timestamp.std.js';
import { createLogger } from '../logging/log.std.js';
import { TaskDeduplicator } from './TaskDeduplicator.std.js';

const log = createLogger('subscriptionConfiguration');

const SUBSCRIPTION_CONFIG_CACHE_TIME = HOUR;

let cachedSubscriptionConfig: SubscriptionConfigurationResultType | undefined;
let cachedSubscriptionConfigExpiresAt: number | undefined;
let donationEndpointsDisabledByServer = false;

function areDonationsEnabled(): boolean {
  return Boolean(window.SignalContext?.config?.donationsEnabled);
}

export function areDonationEndpointsDisabledByServer(): boolean {
  return donationEndpointsDisabledByServer || !areDonationsEnabled();
}

function isCacheRefreshNeeded(): boolean {
  return (
    cachedSubscriptionConfig == null ||
    cachedSubscriptionConfigExpiresAt == null ||
    isInPast(cachedSubscriptionConfigExpiresAt)
  );
}

export async function getCachedSubscriptionConfiguration(): Promise<SubscriptionConfigurationResultType> {
  return getCachedSubscriptionConfigurationDedup.run();
}

const getCachedSubscriptionConfigurationDedup = new TaskDeduplicator(
  'getCachedSubscriptionConfiguration',
  () => _getCachedSubscriptionConfiguration()
);

export async function _getCachedSubscriptionConfiguration(): Promise<SubscriptionConfigurationResultType> {
  if (!areDonationsEnabled()) {
    donationEndpointsDisabledByServer = true;
    throw new HTTPError('Donations disabled', {
      code: 501,
      headers: {},
      stack: '',
    });
  }

  if (isCacheRefreshNeeded()) {
    cachedSubscriptionConfig = undefined;
  }

  if (cachedSubscriptionConfig != null) {
    return cachedSubscriptionConfig;
  }

  log.info('Refreshing config cache');
  let response: SubscriptionConfigurationResultType;
  try {
    response = await getSubscriptionConfiguration();
  } catch (error) {
    if (error instanceof HTTPError && error.code === 501) {
      donationEndpointsDisabledByServer = true;
    }
    throw error;
  }

  cachedSubscriptionConfig = response;
  cachedSubscriptionConfigExpiresAt =
    Date.now() + SUBSCRIPTION_CONFIG_CACHE_TIME;

  return response;
}

export function getCachedSubscriptionConfigExpiresAt(): number | undefined {
  return cachedSubscriptionConfigExpiresAt;
}

export async function getCachedDonationHumanAmounts(): Promise<OneTimeDonationHumanAmounts> {
  const { currencies } = await getCachedSubscriptionConfiguration();
  // pickBy returns a Partial so we need to cast it
  return pickBy(
    currencies,
    ({ supportedPaymentMethods }) =>
      supportedPaymentMethods.includes(PaymentMethod.Card) ||
      supportedPaymentMethods.includes(PaymentMethod.Paypal)
  ) as unknown as OneTimeDonationHumanAmounts;
}

export async function maybeHydrateDonationConfigCache(): Promise<void> {
  if (!areDonationsEnabled()) {
    return;
  }
  if (!isCacheRefreshNeeded()) {
    return;
  }

  const amounts = await getCachedDonationHumanAmounts();
  window.reduxActions.donations.hydrateConfigCache(amounts);
}
