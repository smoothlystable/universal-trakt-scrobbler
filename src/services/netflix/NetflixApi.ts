import { NetflixService } from '@/netflix/NetflixService';
import {
	getNetflixHistoryProgress,
	mergeNetflixHistoryProgress,
	NetflixHistoryProgress,
	NetflixPlaybackMetadata,
} from '@/netflix/NetflixProgress';
import { ServiceApi, ServiceApiSession } from '@apis/ServiceApi';
import { RequestError } from '@common/RequestError';
import { Requests } from '@common/Requests';
import { ScriptInjector } from '@common/ScriptInjector';
import { Shared } from '@common/Shared';
import { Utils } from '@common/Utils';
import { EpisodeItem, MovieItem, ScrobbleItem, ScrobbleItemValues } from '@models/Item';

export interface NetflixGlobalObject {
	appContext: {
		state: {
			playerApp: {
				getState: () => NetflixPlayerState;
			};
		};
	};
	reactContext: {
		models: {
			userInfo: {
				data: {
					authURL: string;
					name: string | null;
					userGuid?: string;
				};
			};
			serverDefs: {
				data: {
					BUILD_IDENTIFIER: string;
				};
			};
		};
	};
}

export interface NetflixPlayerState {
	videoPlayer: {
		playbackStateBySessionId: Record<string, NetflixScrobbleSession | null>;
	};
}

export interface NetflixSession extends ServiceApiSession {
	authUrl: string;
	userGuid?: string;
	buildIdentifier?: string;
}

export interface NetflixScrobbleSession {
	currentTime: number;
	duration: number;
	paused: boolean;
	playing: boolean;
	videoId: number;
}

export interface NetflixInjectedPlayback {
	currentTime: number;
	duration: number;
	isPaused: boolean;
	progress: number;
	videoId: string | null;
}

export interface NetflixHistoryResponse {
	viewedItems: NetflixHistoryItem[];
}

export type NetflixHistoryItem = NetflixHistoryEpisodeItem | NetflixHistoryMovieItem;

export interface NetflixHistoryEpisodeItem extends NetflixHistoryProgress {
	date: number;
	episodeTitle: string;
	movieID: number;
	series: number;
	seriesTitle: string;
	title: string;
}

export interface NetflixHistoryMovieItem extends NetflixHistoryProgress {
	date: number;
	movieID: number;
	title: string;
}

export interface NetflixMetadataResponse {
	value: {
		seasons?: Record<string, NetflixMetadataSeasonItem>;
		videos: Record<string, NetflixMetadataItem>;
	};
}

export type NetflixMetadataItem =
	| NetflixMetadataEpisodeItem
	| NetflixMetadataShowItem
	| NetflixMetadataMovieItem;

export interface NetflixMetadataEpisodeItem {
	releaseYear: number;
	title?: string;
	summary: {
		episode: number;
		id: number;
		season: number;
	};
}

export interface NetflixMetadataSeasonItem {
	summary: {
		hiddenEpisodeNumbers: boolean;
	};
}

export type NetflixMetadataEpisodeItemWithSeason = NetflixMetadataEpisodeItem & {
	season?: NetflixMetadataSeasonItem;
};

export interface NetflixMetadataShowItem {
	title?: string;
	seasonList: {
		current: ['seasons', string];
	};
}

export interface NetflixMetadataMovieItem {
	releaseYear: number;
	title?: string;
	summary: {
		id: number;
	};
}

export interface NetflixSingleMetadataItem {
	video: NetflixMetadataShow | NetflixMetadataMovie;
}

export interface NetflixMetadataGeneric extends NetflixPlaybackMetadata {
	id: number;
	title: string;
	year: number;
}

export type NetflixMetadataShow = NetflixMetadataGeneric & {
	type: 'show';
	currentEpisode: number;
	hiddenEpisodeNumbers: boolean;
	seasons: NetflixMetadataShowSeason[];
};

export interface NetflixMetadataShowSeason {
	episodes: NetflixMetadataShowEpisode[];
	seq: number;
}

export interface NetflixMetadataShowEpisode extends NetflixPlaybackMetadata {
	id: number;
	seq: number;
	title: string;
}

export type NetflixMetadataMovie = NetflixMetadataGeneric & {
	type: 'movie';
};

export type NetflixHistoryItemWithMetadata =
	| NetflixHistoryEpisodeItemWithMetadata
	| NetflixHistoryMovieItemWithMetadata;

export type NetflixHistoryEpisodeItemWithMetadata = NetflixHistoryEpisodeItem &
	NetflixMetadataEpisodeItemWithSeason;

export type NetflixHistoryMovieItemWithMetadata = NetflixHistoryMovieItem &
	NetflixMetadataMovieItem;

export interface NetflixAuiHistoryResponse {
	jsonGraph: {
		aui: {
			viewingActivity?: {
				value?: { viewedItems?: NetflixHistoryItem[] };
			};
		};
	};
}

const NETFLIX_METADATA_RATE_LIMIT = {
	key: 'netflix-member-metadata',
	minIntervalMs: 500,
};

class _NetflixApi extends ServiceApi {
	HOST_URL: string;
	API_URL: string;
	ACTIVATE_URL: string;
	isActivated: boolean;
	session: NetflixSession | null = null;
	override readonly preservePendingHistoryItems = true;
	private metadataUrlTemplate: string | null = null;
	private metadataCache = new Map<string, NetflixSingleMetadataItem | null>();

	constructor() {
		super(NetflixService.id);

		this.HOST_URL = 'https://www.netflix.com';
		this.API_URL = `${this.HOST_URL}/api/shakti`;
		this.ACTIVATE_URL = `${this.HOST_URL}/settings/viewed/`;

		this.isActivated = false;
	}

	reset(): void {
		super.reset();
		this.metadataCache.clear();
	}

	private async fetchActivatePage(maxRetries = 3): Promise<string> {
		// The request occasionally fails at the network level (status -1) right after
		// the extension starts, which would incorrectly show the login prompt,
		// so retry a few times before giving up.
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				return await Requests.send({
					url: this.ACTIVATE_URL,
					method: 'GET',
				});
			} catch (err) {
				lastError = err;
				if (attempt < maxRetries) {
					await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
				}
			}
		}
		throw lastError;
	}

	async activate() {
		// If we can access the global netflix object from the page, there is no need to send a request to Netflix in order to retrieve the session.
		try {
			this.session = await this.getSession();
			if (!this.session) {
				const responseText = await this.fetchActivatePage();
				this.session = this.extractSession(responseText);
			}
			if (this.session?.profileName != null) {
				this.isActivated = true;
			}
		} catch (err) {
			if (Shared.errors.validate(err)) {
				Shared.errors.log(`Failed to activate ${this.id} API`, err);
			}
			throw new Error('Failed to activate API');
		}
	}

	async checkLogin() {
		if (!this.isActivated) {
			await this.activate();
		}
		return this.session?.profileName != null;
	}

	async loadHistoryItems(cancelKey = 'default'): Promise<NetflixHistoryItem[]> {
		if (!this.isActivated) {
			await this.activate();
		}
		if (!this.session) {
			throw new Error('Invalid session');
		}

		const responseItems = await this.fetchHistoryItems(this.nextHistoryPage, 50, cancelKey, 10);

		this.nextHistoryPage += 1;
		this.hasReachedHistoryEnd = Array.isArray(responseItems) && responseItems.length === 0;

		return responseItems;
	}

	private async fetchHistoryItems(
		page: number,
		pageSize: number,
		cancelKey = 'default',
		maxRetries = 10
	): Promise<NetflixHistoryItem[]> {
		if (!this.session) {
			throw new Error('Invalid session');
		}

		const callPath = `["aui","viewingActivity",${page},${pageSize}]`;
		const encodedCallPath = encodeURIComponent(callPath);
		const url = `${this.HOST_URL}/api/aui/pathEvaluator/web/%5E2.0.0?method=call&callPath=${encodedCallPath}&falcor_server=0.1.0`;

		const paramValue = JSON.stringify({ guid: this.session.userGuid });
		const body = `param=${encodeURIComponent(paramValue)}`;

		const headers = {
			'x-netflix.request.routing':
				'{"path":"/nq/aui/endpoint/%5E1.0.0-web/pathEvaluator","control_tag":"auinqweb"}',
		};

		let responseText: string | undefined;
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				responseText = await Requests.send({
					url,
					method: 'POST',
					body,
					headers,
					cancelKey,
				});
				if (responseText) {
					break;
				}
			} catch (err) {
				if (err instanceof RequestError && err.isCanceled) {
					throw err;
				}
				if (attempt === maxRetries) {
					throw err;
				}
			}
		}

		if (!responseText) {
			throw new Error('Failed to fetch history from Netflix API');
		}

		const responseJson = JSON.parse(responseText) as NetflixAuiHistoryResponse;
		return responseJson.jsonGraph.aui.viewingActivity?.value?.viewedItems ?? [];
	}

	isNewHistoryItem(historyItem: NetflixHistoryItem, lastSync: number) {
		return historyItem.date > 0 && Utils.unix(historyItem.date) > lastSync;
	}

	getHistoryItemId(historyItem: NetflixHistoryItem) {
		return historyItem.movieID.toString();
	}

	prepareHistoryItems(historyItems: NetflixHistoryItem[], cancelKey = 'default') {
		return this.getHistoryMetadata(historyItems, cancelKey);
	}

	convertHistoryItems(historyItems: NetflixHistoryItemWithMetadata[]) {
		return historyItems.map((historyItem) => this.parseHistoryItem(historyItem));
	}

	updateItemFromHistory(
		item: ScrobbleItemValues,
		historyItem: NetflixHistoryItemWithMetadata
	): Promisable<void> {
		item.watchedAt = Utils.unix(historyItem.date);
		item.progress = getNetflixHistoryProgress(historyItem.bookmark, historyItem.duration);
	}

	/**
	 * Netflix has been moving the member web API around. The `release` route is the
	 * one that currently works, so it goes first; the others are kept as fallbacks
	 * in case Netflix moves it again.
	 */
	private getApiBaseUrls(): string[] {
		const baseUrls: string[] = [`${this.HOST_URL}/nq/website/memberapi/release`];
		const buildIdentifier = this.session?.buildIdentifier;
		if (buildIdentifier) {
			baseUrls.push(`${this.HOST_URL}/nq/website/memberapi/${buildIdentifier}`);
			baseUrls.push(`${this.API_URL}/${buildIdentifier}`);
		}
		baseUrls.push(`${this.API_URL}/mre`);
		return baseUrls;
	}

	async getHistoryMetadata(historyItems: NetflixHistoryItem[], cancelKey = 'default') {
		if (!this.session) {
			throw new Error('Invalid session');
		}
		// Netflix removed the bulk `pathEvaluator` endpoint (the routes return
		// 502/412/421/404 now), so the metadata is fetched through single metadata
		// requests, one per unique show/movie.
		return this.getHistoryMetadataFromSingleRequests(historyItems, cancelKey);
	}

	/**
	 * Fallback for when the bulk pathEvaluator endpoint is unavailable: the single
	 * metadata endpoint returns a whole show (all seasons and episodes, with English
	 * titles because of `languages=en-US`), so one request per unique show/movie
	 * is enough to combine the history items with their metadata.
	 */
	private async getHistoryMetadataFromSingleRequests(
		historyItems: NetflixHistoryItem[],
		cancelKey: string
	): Promise<NetflixHistoryItemWithMetadata[]> {
		const ids = new Set<number>();
		for (const historyItem of historyItems) {
			ids.add('series' in historyItem ? historyItem.series : historyItem.movieID);
		}

		const metadataById = new Map<number, NetflixSingleMetadataItem | null>();
		let failures = 0;
		let requestFailure: Error | null = null;
		for (const id of ids) {
			let metadata: NetflixSingleMetadataItem | null;
			try {
				metadata = await this.getSingleMetadata(id.toString(), cancelKey);
			} catch (err) {
				if (err instanceof RequestError && err.isCanceled) {
					throw err;
				}
				requestFailure = err instanceof Error ? err : new Error('Metadata request failed');
				break;
			}
			metadataById.set(id, metadata);
			if (!metadata && !this.metadataUrlTemplate) {
				failures += 1;
				// If no metadata endpoint variation works at all,
				// stop probing for the remaining items
				if (failures >= 2) {
					break;
				}
			}
		}

		let hasFailed = false;
		const historyItemsWithMetadata = historyItems.map((historyItem) => {
			let combinedItem: NetflixHistoryItemWithMetadata | null = null;
			if ('series' in historyItem) {
				const video = metadataById.get(historyItem.series)?.video;
				if (video && video.type === 'show') {
					for (const season of video.seasons) {
						const episode = season.episodes.find(
							(currentEpisode) => currentEpisode.id === historyItem.movieID
						);
						if (episode) {
							combinedItem = {
								...historyItem,
								...mergeNetflixHistoryProgress(historyItem, episode),
								releaseYear: video.year,
								seriesTitle: video.title || historyItem.seriesTitle,
								episodeTitle: episode.title || historyItem.episodeTitle,
								summary: {
									episode: episode.seq,
									id: historyItem.movieID,
									season: season.seq,
								},
								season: {
									summary: { hiddenEpisodeNumbers: video.hiddenEpisodeNumbers },
								},
							};
							break;
						}
					}
				}
			} else {
				const video = metadataById.get(historyItem.movieID)?.video;
				if (video && video.type === 'movie') {
					combinedItem = {
						...historyItem,
						...mergeNetflixHistoryProgress(historyItem, video),
						releaseYear: video.year,
						title: video.title || historyItem.title,
						summary: { id: historyItem.movieID },
					};
				}
			}
			if (!combinedItem) {
				hasFailed = true;
			}
			return combinedItem ?? (historyItem as NetflixHistoryItemWithMetadata);
		});

		if (hasFailed) {
			// Without metadata we lose the year and season/episode numbers, but the
			// history can still be loaded and matched on Trakt by title, so don't fail
			Shared.errors.warning(
				'Failed to get metadata for some Netflix history items.',
				requestFailure ?? new Error('Metadata requests failed')
			);
		}

		return historyItemsWithMetadata;
	}

	private async getSingleMetadata(
		id: string,
		cancelKey = 'default'
	): Promise<NetflixSingleMetadataItem | null> {
		if (!this.metadataCache.has(id)) {
			this.metadataCache.set(id, await this.fetchSingleMetadata(id, cancelKey));
		}
		return this.metadataCache.get(id) ?? null;
	}

	private async fetchSingleMetadata(
		id: string,
		cancelKey = 'default'
	): Promise<NetflixSingleMetadataItem | null> {
		const preferredTemplate = this.metadataUrlTemplate;
		const authUrl = encodeURIComponent(this.session?.authUrl ?? '');
		const preferredTemplates = preferredTemplate
			? [
					preferredTemplate,
					...(preferredTemplate.includes('&authURL=')
						? []
						: [`${preferredTemplate}&authURL=${authUrl}`]),
				]
			: [];
		const templates = [
			...preferredTemplates,
			...this.getApiBaseUrls().flatMap((baseUrl) => [
				`${baseUrl}/metadata?languages=en-US&movieid={id}`,
				`${baseUrl}/metadata?languages=en-US&movieid={id}&authURL=${authUrl}`,
			]),
		];

		const uniqueTemplates = [...new Set(templates)];
		for (const [index, template] of uniqueTemplates.entries()) {
			try {
				const responseText = await Requests.send({
					url: template.replace('{id}', id),
					method: 'GET',
					cancelKey,
					rateLimit: NETFLIX_METADATA_RATE_LIMIT,
				});
				const metadata = JSON.parse(responseText) as Partial<NetflixSingleMetadataItem> | null;
				if (metadata && typeof metadata === 'object' && 'video' in metadata) {
					this.metadataUrlTemplate = template;
					return metadata.video ? (metadata as NetflixSingleMetadataItem) : null;
				}
			} catch (err) {
				if (
					!this.shouldTryNextMetadataTemplate(
						err,
						template,
						uniqueTemplates[index + 1],
						template === preferredTemplate
					)
				) {
					throw err;
				}
				if (template === preferredTemplate) {
					this.metadataUrlTemplate = null;
				}
			}
		}

		if (preferredTemplate && this.metadataUrlTemplate === preferredTemplate) {
			this.metadataUrlTemplate = null;
		}
		return null;
	}

	private shouldTryNextMetadataTemplate(
		err: unknown,
		template: string,
		nextTemplate: string | undefined,
		isPreferred: boolean
	): boolean {
		if (!(err instanceof RequestError)) {
			return true;
		}
		if (err.isCanceled) {
			return false;
		}
		if ([400, 404, 412, 421, 502].includes(err.status ?? -1)) {
			return true;
		}
		if (![401, 403].includes(err.status ?? -1)) {
			return false;
		}
		if (err.status === 403 && err.text?.includes('Cloudflare')) {
			return false;
		}
		if (isPreferred) {
			return true;
		}

		const authUrl = encodeURIComponent(this.session?.authUrl ?? '');
		return (
			!!nextTemplate &&
			!template.includes('&authURL=') &&
			nextTemplate === `${template}&authURL=${authUrl}`
		);
	}

	isShow(
		historyItem: NetflixHistoryItemWithMetadata
	): historyItem is NetflixHistoryEpisodeItemWithMetadata {
		return 'series' in historyItem;
	}

	parseHistoryItem(historyItem: NetflixHistoryItemWithMetadata) {
		let item: ScrobbleItem;
		const serviceId = this.id;
		const id = historyItem.movieID.toString();
		const year = historyItem.releaseYear;
		const watchedAt = Utils.unix(historyItem.date);
		const progress = getNetflixHistoryProgress(historyItem.bookmark, historyItem.duration);

		if (this.isShow(historyItem)) {
			const title = historyItem.seriesTitle.trim();

			let season = 0;
			let number = 0;

			// `hiddenEpisodeNumbers` is `true` for collections
			// In this case, the episode should be searched by title instead of season and number,
			// because the numbering differs between Netflix and Trakt.tv for collections
			if (historyItem.season?.summary.hiddenEpisodeNumbers === false) {
				season = historyItem.summary?.season || 0;
				number = historyItem.summary?.episode || 0;
			}

			const episodeTitle = historyItem.episodeTitle.trim();
			item = new EpisodeItem({
				serviceId,
				id,
				title: episodeTitle,
				year,
				season,
				number,
				watchedAt,
				progress,
				show: {
					serviceId,
					title,
					year,
				},
			});
		} else {
			const title = historyItem.title.trim();
			item = new MovieItem({
				serviceId,
				id,
				title,
				year,
				watchedAt,
				progress,
			});
		}
		return item;
	}

	async getItem(id: string): Promise<ScrobbleItem | null> {
		if (!this.isActivated) {
			await this.activate();
		}
		if (!this.session) {
			throw new Error('Invalid session');
		}

		const item = await this.getItemFromMetadata(id);
		if (item) {
			return item;
		}

		return this.getItemFromRecentHistory(id);
	}

	private async getItemFromMetadata(id: string): Promise<ScrobbleItem | null> {
		const metadata = await this.fetchSingleMetadata(id);
		return metadata ? this.parseMetadata(metadata) : null;
	}

	private async getItemFromRecentHistory(id: string): Promise<ScrobbleItem | null> {
		if (!this.session?.userGuid) {
			return null;
		}

		try {
			const historyItems = await this.fetchHistoryItems(0, 50, `item-fallback-${id}`, 3);
			if (historyItems.length === 0) {
				return null;
			}

			const historyItem = historyItems.find((currentItem) => currentItem.movieID.toString() === id);
			if (!historyItem) {
				return null;
			}

			const [historyItemWithMetadata] = await this.getHistoryMetadata([historyItem]);
			return historyItemWithMetadata ? this.parseHistoryItem(historyItemWithMetadata) : null;
		} catch (err) {
			if (Shared.errors.validate(err)) {
				Shared.errors.warning('Failed to get item from recent history.', err);
			}
		}

		return null;
	}

	parseMetadata(metadata: NetflixSingleMetadataItem): ScrobbleItem {
		let item: ScrobbleItem;
		const serviceId = this.id;
		const { video } = metadata;
		const { type, title, year } = video;
		if (type === 'show') {
			const id = video.currentEpisode.toString();
			let episodeInfo: NetflixMetadataShowEpisode | undefined;
			const seasonInfo = video.seasons.find((currentSeason) =>
				currentSeason.episodes.find((currentEpisode) => {
					const isMatch = currentEpisode.id === video.currentEpisode;
					if (isMatch) {
						episodeInfo = currentEpisode;
					}
					return isMatch;
				})
			);
			if (!seasonInfo || !episodeInfo) {
				throw new Error('Could not find item');
			}

			let season = 0;
			let number = 0;

			// `hiddenEpisodeNumbers` is `true` for collections
			// In this case, the episode should be searched by title instead of season and number,
			// because the numbering differs between Netflix and Trakt.tv for collections
			if (!video.hiddenEpisodeNumbers) {
				season = seasonInfo.seq || 0;
				number = episodeInfo.seq || 0;
			}

			const episodeTitle = episodeInfo.title;
			item = new EpisodeItem({
				serviceId,
				id,
				title: episodeTitle,
				year,
				season,
				number,
				show: {
					serviceId,
					id: video.id.toString(),
					title,
				},
			});
		} else {
			const id = video.id.toString();
			item = new MovieItem({
				serviceId,
				id,
				title,
				year,
			});
		}
		return item;
	}

	getSession(): Promise<NetflixSession | null> {
		return ScriptInjector.inject<NetflixSession>(this.id, 'session', '');
	}

	/**
	 * Values captured by regex from the `/settings/viewed/` HTML are raw JavaScript
	 * string literals, so they keep their escapes (e.g. the `==` at the end of
	 * `authURL` arrives as `\x3D\x3D`). Decode the common JS escapes so the values
	 * can be used in requests. The injected-session path doesn't need this because
	 * it reads the already-decoded values straight off the `netflix` object.
	 */
	private decodeJsString(value: string): string {
		return value
			.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
			.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
			.replace(/\\\//g, '/');
	}

	extractSession(text: string): NetflixSession | null {
		let session: NetflixSession | null = null;
		const authUrlRegex = /"authURL":"(?<authUrl>.*?)"/;
		const profileNameRegex = /"userInfo":\{"data":\{"name":"(?<profileName>.*?)"/;
		const userGuidRegex = /"userInfo":\{"data":\{[^}]*"userGuid":"(?<userGuid>.*?)"/;
		const buildIdentifierRegex = /"BUILD_IDENTIFIER":"(?<buildIdentifier>.*?)"/;
		const { authUrl: rawAuthUrl } = authUrlRegex.exec(text)?.groups ?? {};
		const { profileName: rawProfileName } = profileNameRegex.exec(text)?.groups ?? {};
		const authUrl = rawAuthUrl ? this.decodeJsString(rawAuthUrl) : rawAuthUrl;
		const profileName = rawProfileName ? this.decodeJsString(rawProfileName) : null;
		const { userGuid = undefined } = userGuidRegex.exec(text)?.groups ?? {};
		const { buildIdentifier = undefined } = buildIdentifierRegex.exec(text)?.groups ?? {};
		if (authUrl) {
			session = { authUrl, profileName };
			if (userGuid) {
				session.userGuid = userGuid;
			}
			if (buildIdentifier) {
				session.buildIdentifier = buildIdentifier;
			}
		}
		return session;
	}
}

Shared.functionsToInject[`${NetflixService.id}-session`] = () => {
	let session: NetflixSession | null = null;
	const { netflix } = window;
	if (netflix) {
		const { userInfo } = netflix.reactContext.models;
		const authUrl = userInfo.data.authURL;
		const profileName = userInfo.data.name;
		const userGuid = userInfo.data.userGuid;
		const buildIdentifier = netflix.reactContext.models.serverDefs?.data?.BUILD_IDENTIFIER;
		if (authUrl) {
			session = { authUrl, profileName };
			if (userGuid) {
				session.userGuid = userGuid;
			}
			if (buildIdentifier) {
				session.buildIdentifier = buildIdentifier;
			}
		}
	}
	return session;
};

Shared.functionsToInject[`${NetflixService.id}-playback`] = (): NetflixInjectedPlayback | null => {
	let playback: NetflixScrobbleSession | null = null;
	const { netflix } = window;
	if (
		netflix &&
		netflix.appContext &&
		netflix.appContext.state &&
		netflix.appContext.state.playerApp &&
		typeof netflix.appContext.state.playerApp.getState === 'function'
	) {
		const state = netflix.appContext.state.playerApp.getState();
		const sessions = state && state.videoPlayer && state.videoPlayer.playbackStateBySessionId;
		if (sessions) {
			const allSessions = Object.keys(sessions)
				.map((sessionId) => sessions[sessionId])
				.filter((session): session is NetflixScrobbleSession => !!session);
			playback =
				allSessions.find((session) => session.playing) ||
				allSessions.find((session) => !session.paused) ||
				allSessions[0] ||
				null;
		}
	}

	if (!playback || playback.duration <= 0) {
		return null;
	}

	return {
		currentTime: playback.currentTime,
		duration: playback.duration,
		isPaused: playback.paused,
		progress: (playback.currentTime / playback.duration) * 100,
		videoId: playback.videoId ? playback.videoId.toString() : null,
	};
};

export const NetflixApi = new _NetflixApi();
