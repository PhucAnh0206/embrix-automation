import { APIRequestContext, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { TestLogger } from './test-logger';
import { EXTRA_LONG_WAIT } from './timeouts.helper';
import { SavedContext, updateTestContext } from './test-context.helper';
// NOTE: SavedContext is imported from test-context.helper above, NOT declared here.
// A stale duplicate used to live in this file, which made TypeScript fail with
// TS2440 (import declaration conflicts with local declaration) on every build.
// The local copy was also WRONG: its testingDateObj carried 3 date fields where
// the real one carries 6, and it lacked incompleteOrderId and orderUrl. Nothing
// imported it -- page-factory.ts and read-context.spec.ts both take SavedContext
// from test-context.helper -- so it only ever shadowed the real type in here.

/**
 * Represents a service service payload structure for CRM Gateway account setup.
 */
export interface ServicePayload {
  bundleId: string;
  packageId?: string;
  serviceType: string;
  action: string;
  quantity: string;
}

/**
 * Represents a payment profile payload containing method and optional terms.
 */
export interface PaymentProfilePayload {
  paymentMethod: string;
  paymentTerm?: string;
}

/**
 * Represents the complete configuration schema for creating an account and order.
 */
export interface AccountAndOrderPayload {
  userId?: string;
  firstName?: string;
  lastName?: string;
  organization?: string;
  commercialName?: string;
  accountId?: string;
  orderId?: string;
  email?: string;
  country?: string;
  landmark?: string;
  state?: string;
  extraLine?: string;
  postalCode?: string;
  city?: string;
  street?: string;
  orderType?: string;
  district?: string;
  neighbourhood?: string;
  billingOnlyFlag?: string | boolean;
  accounttype?: string;
  groupid?: string;
  groupId?: string;
  staticIpRented?: string | boolean;
  identity?: string;
  identityDocument?: string;
  phone?: string;
  paymentProfiles?: PaymentProfilePayload[];
  billingFrequency?: string;
  billingDom?: string | number;

  // ── JASEC prepaid fields ──────────────────────────────────────────────
  // Verified honoured by POST /processAccountAndOrder on jasec-dev 2026-08-21.
  // Without accountCategory the gateway does NOT produce a prepaid account.
  accountCategory?: string;
  accountSubType?: string;
  customerSegment?: string;
  currency?: string;
  // Accepted but SILENTLY IGNORED - the account is stored with legalEntity 'US'
  // regardless of what is sent. Kept so the payload can mirror the UI row.
  legalEntity?: string;
  services?: ServicePayload[];
}

/**
 * AccountOrderApiHelper — A helper class for managing API requests related to account and order creation/billing.
 */
export class AccountOrderApiHelper {
  private request: APIRequestContext;
  private crmGatewayUrl = process.env.CRM_GATEWAY_URL ?? 'https://crm-gateway.coopeg.embrix.org';
  private logger?: TestLogger;

  /**
   * @param request - Playwright's APIRequestContext for invoking REST APIs.
   * @param logger - Optional TestLogger instance for logging activity details.
   */
  constructor(request: APIRequestContext, logger?: TestLogger) {
    this.request = request;
    this.logger = logger;
  }

  /**
   * Retrieves the bearer authentication token from environment variables.
   * @returns The bearer token string.
   */
  private getBearerToken(): string {
    const token = process.env.EMBRIX_API_BEARER_TOKEN;
    if (!token) {
      throw new Error('EMBRIX_API_BEARER_TOKEN environment variable is not defined.');
    }
    return token;
  }

  /**
   * Loads the default services configurations from test data configuration.
   * @returns An array of default ServicePayload objects.
   */
  private loadServicesConfig(): ServicePayload[] {
    const filePath = path.join(process.cwd(), 'test-data', 'services.config.json');
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as ServicePayload[];
      } catch (e) {
        this.logger?.error('Failed to parse services.config.json, using default services', e);
      }
    }
    return [
      {
        bundleId: "BDL_INT_100MBPS",
        packageId: "",
        serviceType: "INTERNET",
        action: "ADD",
        quantity: "1"
      }
    ];
  }

  /**
   * Loads specific services configuration details mapped by service profile name.
   * @param name - The name of the service profile.
   * @returns An array of ServicePayload objects matching the profile name.
   */
  private loadServicesByName(name?: string): ServicePayload[] {
    if (!name) {
      return this.loadServicesConfig();
    }
    const filePath = path.join(process.cwd(), 'test-data', 'services.data.json');
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        const found = data.find((item: any) => item.name === name);
        if (found && found.services) {
          if (Array.isArray(found.services)) {
            return found.services;
          } else {
            return [found.services];
          }
        }
      } catch (e) {
        this.logger?.error(`Failed to load service data by name "${name}"`, e);
      }
    }
    return this.loadServicesConfig();
  }

  /**
   * Loads the account configuration template from disk.
   * @param profileName - The name of the profile.
   * @returns A partial AccountAndOrderPayload object.
   */
  private loadAccountTemplate(profileName: string): Partial<AccountAndOrderPayload> {
    const filePath = path.join(process.cwd(), 'test-data', 'accounts.data.json');
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        const found = data.find((item: any) => item.name === profileName);
        if (found && found.payload) {
          return found.payload as Partial<AccountAndOrderPayload>;
        }
      } catch (e) {
        this.logger?.error(`Failed to load account profile "${profileName}"`, e);
      }
    }
    return {};
  }

  /**
   * Triggers the processAccountAndOrder API to provision a new customer account and subscription order.
   * Saves the generated IDs into the test session context.
   * 
   * @param customPayload - Optional payload overrides.
   * @param serviceName - Optional service profile name.
   * @param accountProfileName - The template account profile name.
   * @returns The generated SavedContext IDs.
   */
  async createAccountAndOrder(customPayload?: Partial<AccountAndOrderPayload>, serviceName?: string, accountProfileName = "RESIDENTIAL_DEFAULT"): Promise<SavedContext> {
    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    const accountId = `AC-${randomSuffix}`;
    const orderId = `OR-${randomSuffix}`;
    const services = this.loadServicesByName(serviceName);

    const loadedTemplate = this.loadAccountTemplate(accountProfileName);

    const defaultPayload: AccountAndOrderPayload = {
      ...loadedTemplate,
      accountId,
      orderId,
      commercialName: loadedTemplate.commercialName ?? `CREATE_ACT_ORDER_${randomSuffix}`,
      email: loadedTemplate.email ?? `tuan.dao+cus.${randomSuffix}@congerotechnology.com`,
      services
    };

    const finalPayload = { ...defaultPayload, ...customPayload };

    const token = this.getBearerToken();

    const url = `${this.crmGatewayUrl}/processAccountAndOrder`;
    this.logger?.api('POST', url);
    this.logger?.data('Request Payload', finalPayload);

    const response = await this.request.post(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: finalPayload,
      timeout: EXTRA_LONG_WAIT * 2
    });

    const status = response.status();
    const bodyText = await response.text();
    this.logger?.api('POST', url, status, bodyText);

    expect(status).toBe(200);

    const responseJson = JSON.parse(bodyText);
    expect(responseJson.status).toBe('SUCCESS');

    const context = {
      accountId: finalPayload.accountId!,
      orderId: finalPayload.orderId!
    };

    updateTestContext(context);
    this.logger?.data('Saved Test Context', context);
    return context;
  }

  /**
   * Pay an invoice via CRM Gateway API.
   * @param accountId  The account ID
   * @param invoiceId  The invoice ID to pay
   * @param totalAmount The total amount to pay (string, e.g. "19273.67")
   */
  async payInvoice(accountId: string, invoiceId: string, totalAmount: string): Promise<void> {
    const token = this.getBearerToken();

    const url = `${this.crmGatewayUrl}/applyPayment`;
    const cleanAmount = parseFloat(totalAmount.replace(/,/g, ''));
    const requestData = {
      paymentDate: "",
      paymentSource: "BRC",
      allocationData: [
        {
          accountId,
          invoiceId,
          currency: "CRC",
          amount: cleanAmount
        }
      ]
    };
    this.logger?.api('POST', url);
    this.logger?.data('Pay Invoice Request', requestData);

    const response = await this.request.post(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: requestData,
      timeout: EXTRA_LONG_WAIT * 2
    });

    const status = response.status();
    const bodyText = await response.text();
    this.logger?.api('POST', url, status, bodyText);

    expect(status).toBe(200);
  }
}
