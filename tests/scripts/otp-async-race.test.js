import { describe, expect, it, vi } from 'vitest';

import { getOTPCode } from '../../src/ui/scripts/otp.js';
import { getTimeCode } from '../../src/ui/scripts/time.js';

const SERVER_BASE_MS = Date.UTC(2026, 0, 1);

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

async function flushMicrotasks() {
	for (let index = 0; index < 6; index += 1) {
		await Promise.resolve();
	}
}

function createHarness({ nowMs = SERVER_BASE_MS, secretOverrides = {}, reducedMotion = false, storedAnimationMode = null } = {}) {
	const state = {
		localEpochMs: nowMs,
		monotonicMs: 0,
	};
	const secret = {
		id: 'race',
		name: 'Race test',
		secret: 'JBSWY3DPEHPK3PXP',
		period: 30,
		type: 'TOTP',
		...secretOverrides,
	};

	function createClassList() {
		const classes = new Set();
		return {
			add: vi.fn((...names) => names.forEach((name) => classes.add(name))),
			remove: vi.fn((...names) => names.forEach((name) => classes.delete(name))),
			toggle: vi.fn((name, force) => {
				const shouldHave = force === undefined ? !classes.has(name) : force;
				if (shouldHave) {
					classes.add(name);
				} else {
					classes.delete(name);
				}
				return shouldHave;
			}),
			contains: vi.fn((name) => classes.has(name)),
			toString: () => [...classes].join(' '),
		};
	}

	function createElement(textContent, rect = null) {
		const parentElement = { offsetWidth: 0 };
		const attributes = new Map();
		const style = {
			setProperty: vi.fn((name, value) => {
				style[name] = value;
			}),
		};
		const element = {
			textContent,
			className: '',
			classList: createClassList(),
			parentElement,
			parentNode: parentElement,
			style,
			setAttribute: vi.fn((name, value) => attributes.set(name, String(value))),
			getAttribute: vi.fn((name) => attributes.get(name) ?? null),
			getBoundingClientRect: vi.fn(() => rect),
			remove: vi.fn(() => {
				if (element.parentNode && typeof element.parentNode.removeChild === 'function') {
					element.parentNode.removeChild(element);
				}
			}),
		};
		return element;
	}

	const currentRect = { left: 20, top: 32, width: 220, height: 46 };
	const nextRect = { left: 260, top: 40, width: 70, height: 24 };

	const elements = {
		'next-otp-race': createElement('next-initial', nextRect),
		'otp-race': createElement('current-initial', currentRect),
	};
	const createdElements = [];
	const body = {
		children: [],
		appendChild: vi.fn((element) => {
			element.parentNode = body;
			body.children.push(element);
			return element;
		}),
		removeChild: vi.fn((element) => {
			const index = body.children.indexOf(element);
			if (index >= 0) body.children.splice(index, 1);
			element.parentNode = null;
			return element;
		}),
	};
	const timeoutCallbacks = new Map();
	let nextTimeoutId = 0;
	const setTimeout = vi.fn((callback, delay) => {
		const id = ++nextTimeoutId;
		timeoutCallbacks.set(id, { callback, delay });
		return id;
	});
	const clearTimeout = vi.fn((id) => {
		timeoutCallbacks.delete(id);
	});

	function FakeDate(...args) {
		return new Date(...(args.length > 0 ? args : [FakeDate.now()]));
	}
	FakeDate.now = () => state.localEpochMs + state.monotonicMs;
	FakeDate.UTC = Date.UTC;
	FakeDate.parse = Date.parse;

	const performance = {
		now: () => state.monotonicMs,
	};
	const document = {
		hidden: false,
		body,
		addEventListener: vi.fn(),
		getElementById: vi.fn((id) => elements[id] ?? null),
		createElement: vi.fn((tagName) => {
			const element = createElement('', null);
			element.tagName = String(tagName).toUpperCase();
			createdElements.push(element);
			return element;
		}),
	};
	const localStorage = {
		getItem: vi.fn((key) => (key === '2fa-otp-animation' ? storedAnimationMode : null)),
		removeItem: vi.fn(),
		setItem: vi.fn(),
	};
	const silentConsole = {
		error: vi.fn(),
		log: vi.fn(),
		warn: vi.fn(),
	};
	const window = {
		addEventListener: vi.fn(),
		crypto: globalThis.crypto,
		matchMedia: vi.fn(() => ({ matches: reducedMotion })),
		setInterval: vi.fn(),
	};

	const api = new Function(
		'Date',
		'performance',
		'fetch',
		'localStorage',
		'navigator',
		'document',
		'window',
		'setTimeout',
		'clearTimeout',
		'setInterval',
		'clearInterval',
		'AbortController',
		'console',
		'secrets',
		'otpIntervals',
		`${getTimeCode()}${getOTPCode()}; return {
			trustedClock,
			otpCalculator,
			getOTPAnimationMode,
			setOTPAnimationMode,
			updateOTP
		};`,
	)(
		FakeDate,
		performance,
		vi.fn(),
		localStorage,
		{ onLine: true },
		document,
		window,
		setTimeout,
		clearTimeout,
		vi.fn(),
		vi.fn(),
		AbortController,
		silentConsole,
		[secret],
		{},
	);

	const generationCalls = [];
	api.otpCalculator.generateTOTP = vi.fn((_secret, counter) => {
		const deferred = createDeferred();
		generationCalls.push({ counter, ...deferred });
		return deferred.promise;
	});

	async function runTimeouts() {
		const callbacks = [...timeoutCallbacks.entries()];
		for (const [id, { callback }] of callbacks) {
			if (!timeoutCallbacks.has(id)) {
				continue;
			}
			timeoutCallbacks.delete(id);
			callback();
			await Promise.resolve();
		}
	}

	return {
		api,
		body,
		clearTimeout,
		createdElements,
		document,
		elements,
		generationCalls,
		localStorage,
		runTimeouts,
		setTimeout,
		state,
		timeoutCallbacks,
		window,
	};
}

async function resolveGenerationPair(harness, currentToken, nextToken, startIndex = 0) {
	harness.generationCalls[startIndex].resolve(currentToken);
	harness.generationCalls[startIndex + 1].resolve(nextToken);
	await flushMicrotasks();
}

async function advanceOneWindow(harness) {
	const initialUpdate = harness.api.updateOTP('race');
	await resolveGenerationPair(harness, 'current-0', 'promoted-current');
	await initialUpdate;

	harness.state.monotonicMs += 30_000;
	const promotedUpdate = harness.api.updateOTP('race');
	await resolveGenerationPair(harness, 'promoted-current', 'next-1', 2);
	await promotedUpdate;
}

function getAnimationAdds(harness, elementId) {
	return harness.elements[elementId].classList.add.mock.calls.flat();
}

describe('OTP asynchronous result races', () => {
	it('does not let a pre-sync WebCrypto result overwrite the synchronized DOM', async () => {
		const harness = createHarness({ storedAnimationMode: 'flow' });
		const initialWindow = harness.api.otpCalculator.getCurrentTimeWindow(30);
		const initialGeneration = harness.api.trustedClock.generation;

		const staleUpdate = harness.api.updateOTP('race');
		expect(harness.generationCalls.map((call) => call.counter)).toEqual([initialWindow, initialWindow + 1]);

		harness.api.trustedClock.establishAnchor(SERVER_BASE_MS + 30_000, harness.state.monotonicMs);
		harness.api.trustedClock.generation += 1;
		expect(harness.api.trustedClock.generation).toBe(initialGeneration + 1);

		const synchronizedUpdate = harness.api.updateOTP('race');
		expect(harness.generationCalls.map((call) => call.counter)).toEqual([
			initialWindow,
			initialWindow + 1,
			initialWindow + 1,
			initialWindow + 2,
		]);

		harness.generationCalls[2].resolve('fresh-current');
		harness.generationCalls[3].resolve('fresh-next');
		await synchronizedUpdate;
		expect(harness.elements['otp-race'].textContent).toBe('fresh-current');
		expect(harness.elements['next-otp-race'].textContent).toBe('fresh-next');

		harness.generationCalls[0].resolve('stale-current');
		// The old "next" calculation targets the new current window and is deterministic.
		harness.generationCalls[1].resolve('fresh-current');
		await staleUpdate;

		expect(harness.elements['otp-race'].textContent).toBe('fresh-current');
		expect(harness.elements['next-otp-race'].textContent).toBe('fresh-next');
		expect(getAnimationAdds(harness, 'otp-race')).toEqual([]);
		expect(getAnimationAdds(harness, 'next-otp-race')).toEqual([]);
	});

	it('keeps the first render and same-window refresh animation-free', async () => {
		const harness = createHarness({ storedAnimationMode: 'flow' });
		const firstUpdate = harness.api.updateOTP('race');

		expect(harness.generationCalls).toHaveLength(2);
		await resolveGenerationPair(harness, 'current-0', 'next-0');
		await firstUpdate;

		expect(harness.elements['otp-race'].textContent).toBe('current-0');
		expect(harness.elements['next-otp-race'].textContent).toBe('next-0');
		expect(getAnimationAdds(harness, 'otp-race')).toEqual([]);
		expect(getAnimationAdds(harness, 'next-otp-race')).toEqual([]);
		expect(harness.setTimeout).not.toHaveBeenCalled();
		expect(harness.document.createElement).not.toHaveBeenCalled();
		expect(harness.body.children).toHaveLength(0);

		await harness.api.updateOTP('race');

		expect(getAnimationAdds(harness, 'otp-race')).toEqual([]);
		expect(getAnimationAdds(harness, 'next-otp-race')).toEqual([]);
		expect(harness.setTimeout).not.toHaveBeenCalled();
		expect(harness.document.createElement).not.toHaveBeenCalled();
		expect(harness.body.children).toHaveLength(0);
	});

	it.each([
		['flow', 'otp-promote-current', 'otp-promote-next', 'otp-promotion-flyer-active', 420, true],
		['flip', 'otp-promote-flip-current', 'otp-promote-flip-next', 'otp-promotion-flyer-flip', 520, false],
		['spotlight', 'otp-promote-spotlight-current', 'otp-promote-spotlight-next', 'otp-promotion-flyer-spotlight', 460, false],
	])(
		'uses the %s handoff to promote the previous next code into current',
		async (mode, currentClass, nextClass, flyerClass, duration, usesTravelPath) => {
			const harness = createHarness({ storedAnimationMode: mode });

			expect(harness.api.getOTPAnimationMode()).toBe(mode);
			await advanceOneWindow(harness);

			const currentElement = harness.elements['otp-race'];
			const nextElement = harness.elements['next-otp-race'];
			expect(currentElement.textContent).toBe('promoted-current');
			expect(nextElement.textContent).toBe('next-1');
			expect(currentElement.textContent).not.toBe(nextElement.textContent);
			expect(getAnimationAdds(harness, 'otp-race')).toEqual([currentClass]);
			expect(getAnimationAdds(harness, 'next-otp-race')).toEqual([nextClass]);
			expect(harness.setTimeout).toHaveBeenCalledTimes(1);
			expect(harness.setTimeout).toHaveBeenCalledWith(expect.any(Function), duration);

			// The transient copy proves that the previous right-side code becomes current.
			expect(harness.document.createElement).toHaveBeenCalledWith('span');
			expect(harness.body.appendChild).toHaveBeenCalledTimes(1);
			expect(harness.body.children).toHaveLength(1);
			const flyer = harness.body.children[0];
			expect(flyer.tagName).toBe('SPAN');
			expect(flyer.className).toBe('otp-promotion-flyer');
			expect(flyer.textContent).toBe(currentElement.textContent);
			expect(flyer.textContent).not.toBe(nextElement.textContent);
			expect(flyer.getAttribute('aria-hidden')).toBe('true');
			expect(flyer.classList.contains(flyerClass)).toBe(true);
			expect(flyer.style.left).toBe('295px');
			expect(flyer.style.top).toBe('52px');
			expect(flyer.style.position).toBe('fixed');
			expect(flyer.style.pointerEvents).toBe('none');
			expect(flyer.style.userSelect).toBe('none');
			if (usesTravelPath) {
				expect(flyer.style['--otp-fly-x']).toBe('-165px');
				expect(flyer.style['--otp-fly-y']).toBe('3px');
				expect(flyer.style['--otp-fly-start-scale']).toBe('0.35');
			} else {
				// Flip and spotlight stay at the source slot and apply their effect in place.
				expect(flyer.style['--otp-fly-x']).toBeUndefined();
				expect(flyer.style['--otp-fly-y']).toBeUndefined();
				expect(flyer.style['--otp-fly-start-scale']).toBeUndefined();
			}

			// A refresh in the same window must not replay the handoff.
			await harness.api.updateOTP('race');
			expect(getAnimationAdds(harness, 'otp-race')).toEqual([currentClass]);
			expect(getAnimationAdds(harness, 'next-otp-race')).toEqual([nextClass]);
			expect(harness.document.createElement).toHaveBeenCalledTimes(1);
			expect(harness.body.children).toHaveLength(1);

			await harness.runTimeouts();
			expect(currentElement.classList.contains(currentClass)).toBe(false);
			expect(nextElement.classList.contains(nextClass)).toBe(false);
			expect(currentElement.classList.remove).toHaveBeenCalledWith(currentClass);
			expect(nextElement.classList.remove).toHaveBeenCalledWith(nextClass);
			expect(harness.clearTimeout).toHaveBeenCalledTimes(1);
			expect(harness.timeoutCallbacks.size).toBe(0);
			expect(flyer.remove).toHaveBeenCalledTimes(1);
			expect(harness.body.children).toHaveLength(0);
		},
	);

	it.each([
		[null, 'the default preference'],
		['none', 'an explicit preference'],
	])('disables promotion effects entirely for %s (%s)', async (storedAnimationMode) => {
		const harness = createHarness({ storedAnimationMode });

		expect(harness.api.getOTPAnimationMode()).toBe('none');
		await advanceOneWindow(harness);

		expect(getAnimationAdds(harness, 'otp-race')).toEqual([]);
		expect(getAnimationAdds(harness, 'next-otp-race')).toEqual([]);
		expect(harness.elements['otp-race'].classList.remove).not.toHaveBeenCalled();
		expect(harness.elements['next-otp-race'].classList.remove).not.toHaveBeenCalled();
		expect(harness.setTimeout).not.toHaveBeenCalled();
		expect(harness.document.createElement).not.toHaveBeenCalled();
		expect(harness.body.children).toHaveLength(0);
	});

	it('cleans up an active flow animation immediately when the mode changes to none', async () => {
		const harness = createHarness({ storedAnimationMode: 'flow' });
		await advanceOneWindow(harness);

		expect(harness.elements['otp-race'].classList.contains('otp-promote-current')).toBe(true);
		expect(harness.elements['next-otp-race'].classList.contains('otp-promote-next')).toBe(true);
		expect(harness.timeoutCallbacks.size).toBe(1);
		expect(harness.body.children).toHaveLength(1);
		const flyer = harness.body.children[0];

		expect(harness.api.setOTPAnimationMode('none')).toBe('none');

		expect(harness.elements['otp-race'].classList.contains('otp-promote-current')).toBe(false);
		expect(harness.elements['next-otp-race'].classList.contains('otp-promote-next')).toBe(false);
		expect(harness.clearTimeout).toHaveBeenCalledTimes(1);
		expect(harness.timeoutCallbacks.size).toBe(0);
		expect(flyer.remove).toHaveBeenCalledTimes(1);
		expect(harness.body.children).toHaveLength(0);
	});

	it('falls back invalid preferences to none and persists mode changes through the public API', async () => {
		const harness = createHarness({ storedAnimationMode: 'spin' });

		expect(harness.localStorage.getItem).toHaveBeenCalledWith('2fa-otp-animation');
		expect(harness.api.getOTPAnimationMode()).toBe('none');
		expect(harness.api.setOTPAnimationMode('flip')).toBe('flip');
		expect(harness.api.getOTPAnimationMode()).toBe('flip');
		expect(harness.localStorage.setItem).toHaveBeenLastCalledWith('2fa-otp-animation', 'flip');

		expect(harness.api.setOTPAnimationMode('unknown')).toBe('none');
		expect(harness.api.getOTPAnimationMode()).toBe('none');
		expect(harness.localStorage.setItem).toHaveBeenLastCalledWith('2fa-otp-animation', 'none');
	});

	it('normalizes the legacy fade preference to spotlight', () => {
		const harness = createHarness({ storedAnimationMode: 'fade' });

		expect(harness.api.getOTPAnimationMode()).toBe('spotlight');
		expect(harness.api.setOTPAnimationMode('fade')).toBe('spotlight');
		expect(harness.api.getOTPAnimationMode()).toBe('spotlight');
		expect(harness.localStorage.setItem).toHaveBeenLastCalledWith('2fa-otp-animation', 'spotlight');
	});

	it('keeps the code update safe and skips the traveler when reduced motion is preferred', async () => {
		const harness = createHarness({ reducedMotion: true, storedAnimationMode: 'flow' });
		const initialUpdate = harness.api.updateOTP('race');
		await resolveGenerationPair(harness, 'current-0', 'promoted-current');
		await initialUpdate;

		harness.state.monotonicMs += 30_000;
		const promotedUpdate = harness.api.updateOTP('race');
		await resolveGenerationPair(harness, 'promoted-current', 'next-1', 2);
		await expect(promotedUpdate).resolves.toBeUndefined();

		expect(harness.elements['otp-race'].textContent).toBe('promoted-current');
		expect(harness.elements['next-otp-race'].textContent).toBe('next-1');
		expect(getAnimationAdds(harness, 'otp-race')).toEqual([]);
		expect(getAnimationAdds(harness, 'next-otp-race')).toEqual([]);
		expect(harness.setTimeout).not.toHaveBeenCalled();
		expect(harness.document.createElement).not.toHaveBeenCalled();
		expect(harness.body.children).toHaveLength(0);
		expect(harness.window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
	});

	it('does not animate when the result skips more than one time window', async () => {
		const harness = createHarness({ storedAnimationMode: 'flow' });
		const initialUpdate = harness.api.updateOTP('race');
		await resolveGenerationPair(harness, 'current-0', 'next-0');
		await initialUpdate;

		harness.state.monotonicMs += 60_000;
		const skippedUpdate = harness.api.updateOTP('race');
		await resolveGenerationPair(harness, 'current-2', 'next-2', 2);
		await skippedUpdate;

		expect(harness.elements['otp-race'].textContent).toBe('current-2');
		expect(harness.elements['next-otp-race'].textContent).toBe('next-2');
		expect(getAnimationAdds(harness, 'otp-race')).toEqual([]);
		expect(getAnimationAdds(harness, 'next-otp-race')).toEqual([]);
		expect(harness.setTimeout).not.toHaveBeenCalled();
		expect(harness.document.createElement).not.toHaveBeenCalled();
		expect(harness.body.children).toHaveLength(0);
	});

	it('ignores an obsolete asynchronous window result without replaying the animation', async () => {
		const harness = createHarness({ storedAnimationMode: 'flow' });
		const initialUpdate = harness.api.updateOTP('race');
		await resolveGenerationPair(harness, 'current-0', 'promoted-current');
		await initialUpdate;

		harness.state.monotonicMs += 30_000;
		const staleUpdate = harness.api.updateOTP('race');
		harness.api.trustedClock.generation += 1;
		const freshUpdate = harness.api.updateOTP('race');
		expect(harness.generationCalls).toHaveLength(6);

		await resolveGenerationPair(harness, 'promoted-current', 'next-fresh', 4);
		await freshUpdate;
		expect(getAnimationAdds(harness, 'otp-race')).toEqual(['otp-promote-current']);
		expect(getAnimationAdds(harness, 'next-otp-race')).toEqual(['otp-promote-next']);

		await resolveGenerationPair(harness, 'stale-current', 'stale-next', 2);
		await staleUpdate;

		expect(harness.elements['otp-race'].textContent).toBe('promoted-current');
		expect(harness.elements['next-otp-race'].textContent).toBe('next-fresh');
		expect(getAnimationAdds(harness, 'otp-race')).toEqual(['otp-promote-current']);
		expect(getAnimationAdds(harness, 'next-otp-race')).toEqual(['otp-promote-next']);
	});

	it('keeps HOTP updates safe and animation-free', async () => {
		const harness = createHarness({ secretOverrides: { type: 'HOTP' }, storedAnimationMode: 'flow' });
		const firstUpdate = harness.api.updateOTP('race');
		await resolveGenerationPair(harness, 'hotp-current-0', 'hotp-next');
		await firstUpdate;

		harness.state.monotonicMs += 30_000;
		const secondUpdate = harness.api.updateOTP('race');
		await resolveGenerationPair(harness, 'hotp-next', 'hotp-next-1', 2);
		await expect(secondUpdate).resolves.toBeUndefined();

		expect(harness.elements['otp-race'].textContent).toBe('hotp-next');
		expect(harness.elements['next-otp-race'].textContent).toBe('hotp-next-1');
		expect(getAnimationAdds(harness, 'otp-race')).toEqual([]);
		expect(getAnimationAdds(harness, 'next-otp-race')).toEqual([]);
		expect(harness.setTimeout).not.toHaveBeenCalled();
		expect(harness.document.createElement).not.toHaveBeenCalled();
		expect(harness.body.children).toHaveLength(0);
	});

	it('recalculates instead of committing results when the time window changes during await', async () => {
		const windowStartMs = Math.floor(SERVER_BASE_MS / 30_000) * 30_000;
		const harness = createHarness({ nowMs: windowStartMs + 29_900, storedAnimationMode: 'flow' });
		const initialWindow = harness.api.otpCalculator.getCurrentTimeWindow(30);

		const update = harness.api.updateOTP('race');
		expect(harness.generationCalls.map((call) => call.counter)).toEqual([initialWindow, initialWindow + 1]);

		harness.state.monotonicMs += 200;
		harness.generationCalls[0].resolve('expired-current');
		harness.generationCalls[1].resolve('new-current');
		await flushMicrotasks();

		expect(harness.elements['otp-race'].textContent).toBe('current-initial');
		expect(harness.elements['next-otp-race'].textContent).toBe('next-initial');
		expect(harness.generationCalls.map((call) => call.counter)).toEqual([initialWindow, initialWindow + 1, initialWindow + 2]);

		harness.generationCalls[2].resolve('new-next');
		await update;
		await flushMicrotasks();

		expect(harness.elements['otp-race'].textContent).toBe('new-current');
		expect(harness.elements['next-otp-race'].textContent).toBe('new-next');
	});
});
