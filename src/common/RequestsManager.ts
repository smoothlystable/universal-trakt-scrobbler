import { RequestsCancelData, StorageOptionsChangeData } from '@common/Events';
import { Shared } from '@common/Shared';
import { getServices } from '@models/Service';
import browser, { WebRequest as WebExtWebRequest } from 'webextension-polyfill';

export interface RequestRateLimit {
	key: string;
	minIntervalMs: number;
}

export interface RateLimitPermit {
	markStarted(): void;
	release(): void;
}

interface RateLimitWaiter {
	signal: AbortSignal;
	resolve: PromiseResolve<RateLimitPermit>;
	reject: PromiseReject;
	onAbort: () => void;
}

interface RateLimitState {
	active: boolean;
	lastStartedAt: number;
	minIntervalMs: number;
	pausedUntil: number;
	queue: RateLimitWaiter[];
	timer?: ReturnType<typeof setTimeout>;
}

class _RequestsManager {
	abortControllers = new Map<string, AbortController>();
	private rateLimits = new Map<string, RateLimitState>();

	init() {
		if (Shared.pageType === 'background') {
			this.checkWebRequestListener();
			this.checkTabListener();
			Shared.events.subscribe('STORAGE_OPTIONS_CHANGE', null, this.onStorageOptionsChange);
		}
		Shared.events.subscribe('REQUESTS_CANCEL', null, this.onRequestsCancel);
	}

	onStorageOptionsChange = (data: StorageOptionsChangeData) => {
		if (data.options && 'grantCookies' in data.options) {
			this.checkWebRequestListener();
		}
	};

	checkWebRequestListener() {
		if (!browser.webRequest) {
			return;
		}

		const { grantCookies } = Shared.storage.options;
		if (
			grantCookies &&
			!browser.webRequest.onBeforeSendHeaders.hasListener(this.onBeforeSendHeaders)
		) {
			const filters: WebExtWebRequest.RequestFilter = {
				types: ['xmlhttprequest'],
				urls: [
					'*://*.trakt.tv/*',
					...getServices()
						.map((service) => service.hostPatterns)
						.flat(),
				],
			};
			browser.webRequest.onBeforeSendHeaders.addListener(this.onBeforeSendHeaders, filters, [
				'blocking',
				'requestHeaders',
			]);
		} else if (
			!grantCookies &&
			browser.webRequest.onBeforeSendHeaders.hasListener(this.onBeforeSendHeaders)
		) {
			browser.webRequest.onBeforeSendHeaders.removeListener(this.onBeforeSendHeaders);
		}
	}

	/**
	 * Makes sure cookies are set for requests.
	 */
	onBeforeSendHeaders = ({ requestHeaders }: WebExtWebRequest.BlockingResponse) => {
		if (!requestHeaders) {
			return;
		}
		const utsCookies = requestHeaders.find((header) => header.name.toLowerCase() === 'uts-cookie');
		if (!utsCookies) {
			return;
		}
		requestHeaders = requestHeaders.filter((header) => header.name.toLowerCase() !== 'cookie');
		utsCookies.name = 'Cookie';
		return {
			requestHeaders,
		};
	};

	checkTabListener() {
		if (!browser.tabs.onRemoved.hasListener(this.onTabRemoved)) {
			browser.tabs.onRemoved.addListener(this.onTabRemoved);
		}
	}

	onTabRemoved = (tabId: number) => {
		this.cancelTabRequests(tabId);
	};

	onRequestsCancel = (data: RequestsCancelData) => {
		this.cancelRequests(data.tabId !== null ? `${data.tabId}_${data.key}` : data.key);
	};

	getAbortSignal(tabId: number | null, cancelKey = 'default'): AbortSignal {
		const key = `${tabId !== null ? `${tabId}_` : ''}${cancelKey}`;
		if (!this.abortControllers.has(key)) {
			this.abortControllers.set(key, new AbortController());
		}
		return this.abortControllers.get(key)!.signal;
	}

	acquireRateLimit(policy: RequestRateLimit, signal: AbortSignal): Promise<RateLimitPermit> {
		if (!policy.key || !Number.isFinite(policy.minIntervalMs) || policy.minIntervalMs < 0) {
			return Promise.reject(new Error('Invalid request rate limit'));
		}
		if (signal.aborted) {
			return Promise.reject(new Error('Request canceled'));
		}

		let state = this.rateLimits.get(policy.key);
		if (state) {
			if (state.minIntervalMs !== policy.minIntervalMs) {
				return Promise.reject(new Error(`Conflicting request rate limit for "${policy.key}"`));
			}
		} else {
			state = {
				active: false,
				lastStartedAt: Number.NEGATIVE_INFINITY,
				minIntervalMs: policy.minIntervalMs,
				pausedUntil: 0,
				queue: [],
			};
			this.rateLimits.set(policy.key, state);
		}

		return new Promise<RateLimitPermit>((resolve, reject) => {
			const waiter: RateLimitWaiter = {
				signal,
				resolve,
				reject,
				onAbort: () => {
					const index = state.queue.indexOf(waiter);
					if (index < 0) {
						return;
					}
					state.queue.splice(index, 1);
					reject(new Error('Request canceled'));
					this.drainRateLimit(policy.key, state);
				},
			};
			signal.addEventListener('abort', waiter.onAbort, { once: true });
			state.queue.push(waiter);
			this.drainRateLimit(policy.key, state);
		});
	}

	pauseRateLimit(key: string, delayMs: number): void {
		const state = this.rateLimits.get(key);
		if (!state || !Number.isFinite(delayMs) || delayMs <= 0) {
			return;
		}
		state.pausedUntil = Math.max(state.pausedUntil, performance.now() + delayMs);
		this.drainRateLimit(key, state);
	}

	private drainRateLimit(key: string, state: RateLimitState): void {
		if (state.timer) {
			clearTimeout(state.timer);
			delete state.timer;
		}
		if (state.active || state.queue.length === 0) {
			return;
		}

		const nextStartAt = Math.max(state.lastStartedAt + state.minIntervalMs, state.pausedUntil);
		const delayMs = nextStartAt - performance.now();
		if (delayMs > 0) {
			state.timer = setTimeout(() => {
				delete state.timer;
				this.drainRateLimit(key, state);
			}, Math.ceil(delayMs));
			return;
		}

		const waiter = state.queue.shift()!;
		waiter.signal.removeEventListener('abort', waiter.onAbort);
		if (waiter.signal.aborted) {
			waiter.reject(new Error('Request canceled'));
			this.drainRateLimit(key, state);
			return;
		}

		state.active = true;
		let hasStarted = false;
		let hasReleased = false;
		waiter.resolve({
			markStarted: () => {
				if (hasStarted || hasReleased) {
					return;
				}
				hasStarted = true;
				state.lastStartedAt = performance.now();
			},
			release: () => {
				if (hasReleased) {
					return;
				}
				hasReleased = true;
				state.active = false;
				this.drainRateLimit(key, state);
			},
		});
	}

	cancelRequests(key: string) {
		const abortController = this.abortControllers.get(key);
		if (abortController) {
			abortController.abort();
			this.abortControllers.delete(key);
		}
	}

	cancelTabRequests(tabId: number) {
		const entries = [...this.abortControllers.entries()].filter(([key]) =>
			key.startsWith(`${tabId}_`)
		);
		for (const [key, abortController] of entries) {
			abortController.abort();
			this.abortControllers.delete(key);
		}
	}
}

export const RequestsManager = new _RequestsManager();
