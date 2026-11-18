
export type CompactionOrigin = "boundary-draft";

export interface CompactionSeamInfo {
	origin: CompactionOrigin;
	entryId?: string;
	midRun: boolean;
	tokensBefore?: number;
	summaryChars: number;
}

export interface CompactionSubscriber {
	before?: (info: CompactionSeamInfo) => void;
	after?: (info: CompactionSeamInfo) => void;
}

interface RegisteredSubscriber {
	id: number;
	subscriber: CompactionSubscriber;
}

let nextSubscriberId = 1;
let subscribers: RegisteredSubscriber[] = [];
const deliveredAfterEntryIds = new Set<string>();

export function registerCompactionSubscriber(subscriber: CompactionSubscriber): () => void {
	const entry: RegisteredSubscriber = { id: nextSubscriberId++, subscriber };
	subscribers.push(entry);
	return () => {
		subscribers = subscribers.filter((candidate) => candidate.id !== entry.id);
	};
}

export function notifyBefore(info: CompactionSeamInfo): void {
	for (const { subscriber } of subscribers) {
		try {
			subscriber.before?.(info);
		} catch {
			// SM-01: one subscriber's bug must not break the draft return path.
		}
	}
}

export function notifyAfter(info: CompactionSeamInfo): void {
	if (info.entryId !== undefined) {
		if (deliveredAfterEntryIds.has(info.entryId)) return;
		deliveredAfterEntryIds.add(info.entryId);
	}
	for (const { subscriber } of subscribers) {
		try {
			subscriber.after?.(info);
		} catch {
		}
	}
}

export function resetCompactionSeam(): void {
	subscribers = [];
	deliveredAfterEntryIds.clear();
}
