import { TraktSearch } from '../../api/TraktSearch';
import { TraktSync } from '../../api/TraktSync';
import { BrowserStorage, CorrectItem } from '../../common/BrowserStorage';
import { Errors } from '../../common/Errors';
import { EventDispatcher } from '../../common/Events';
import { Item } from '../../models/Item';
import { TraktItem, TraktItemBase } from '../../models/TraktItem';
import { StreamingServiceId } from '../streaming-services';
import { getSyncStore } from './common';

export abstract class Api {
	id: StreamingServiceId;

	constructor(id: StreamingServiceId) {
		this.id = id;
	}

	abstract loadHistory(
		nextPage: number,
		nextVisualPage: number,
		itemsToLoad: number
	): Promise<void>;

	loadTraktHistory = async () => {
		try {
			const storage = await BrowserStorage.get(['correctItems', 'traktCache']);
			const { correctItems } = storage;
			let { traktCache } = storage;
			if (!traktCache) {
				traktCache = {};
			}
			const promises = [];
			const items = getSyncStore(this.id).data.items;
			for (const item of items) {
				promises.push(
					this.loadTraktItemHistory(item, traktCache, correctItems?.[this.id]?.[item.id])
				);
			}
			await Promise.all(promises);
			await BrowserStorage.set({ traktCache }, false);
			await getSyncStore(this.id).update();
		} catch (err) {
			Errors.error('Failed to load Trakt history.', err);
			await EventDispatcher.dispatch('TRAKT_HISTORY_LOAD_ERROR', null, {
				error: err as Error,
			});
		}
	};

	loadTraktItemHistory = async (
		item: Item,
		traktCache: Record<string, TraktItemBase>,
		correctItem?: CorrectItem
	) => {
		if (item.trakt && !correctItem) {
			return;
		}
		try {
			const cacheId = this.getTraktCacheId(item);
			const cacheItem = traktCache[cacheId];
			item.trakt =
				correctItem || !cacheItem
					? await TraktSearch.find(item, correctItem)
					: new TraktItem(cacheItem);
			await TraktSync.loadHistory(item);
			if (item.trakt) {
				traktCache[cacheId] = TraktItem.getBase(item.trakt);
			}
		} catch (err) {
			item.trakt = null;
		}
	};

	getTraktCacheId = (item: Item): string => {
		return item.type === 'show'
			? `/shows/${this.getTraktCacheStr(item.title)}/seasons/${item.season ?? 0}/episodes/${
					item.episode ?? this.getTraktCacheStr(item.episodeTitle ?? '0')
			  }`
			: `/movies/${this.getTraktCacheStr(item.title)}${item.year ? `-${item.year}` : ''}`;
	};

	getTraktCacheStr = (title: string): string => {
		return title.toLowerCase().replace(/[^\w]/g, '-').replace(/-+/g, '-');
	};
}
