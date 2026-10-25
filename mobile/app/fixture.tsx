/**
 * `hermetic://fixture?…`, fixture builds only: put the app into a given state
 * (pair with the canned fleet, listen, pick the primary, avatar style, theme)
 * and open a route, with no tap. It is for screenshot runs driven by
 * `xcrun simctl openurl booted "<url>"`; the grammar is in
 * `src/fixture/drive.ts`, reached only through the kit (`fixture.drive`), so
 * this file holds no static import of `src/fixture/`.
 *
 * Without the fixture (every release build, and a development build without
 * the flag) the link does nothing: it goes to the entry, which opens Pair, the
 * primary picker or home as usual.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { Linking, View } from "react-native";
import type { HermeticClient } from "../src/client/client.ts";
import { type FixtureDriveActions, useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { pairPrefsPatch, readPairingLink } from "../src/fleet/pairing.ts";
import { usePrefs } from "../src/prefs/prefs.tsx";
import { useTheme } from "../src/theme/theme.tsx";

/** Leave for `href`, dropping whatever the link opened over, so back cannot return here. */
function leave(href: string): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace(href as never);
}

/** How long `createBot` waits for the provider's client (one is built when a pairing starts). */
const CLIENT_WAIT_MS = 10_000;

/**
 * The provider's current client, as a promise: at once when there is one the
 * drive has not replaced, else the next one the provider builds. A pairing in
 * the same link marks the client it replaces (`markStale`), since this
 * render's closure still holds it.
 */
function useNextClient(client: HermeticClient | null) {
  const current = useRef(client);
  const stale = useRef<HermeticClient | null>(null);
  const waiters = useRef<((c: HermeticClient) => void)[]>([]);
  useEffect(() => {
    current.current = client;
    if (client && client !== stale.current) for (const wake of waiters.current.splice(0)) wake(client);
  }, [client]);
  return useRef({
    markStale: () => {
      stale.current = current.current;
    },
    next: (): Promise<HermeticClient> => {
      const now = current.current;
      if (now && now !== stale.current) return Promise.resolve(now);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("no client to create the bot with")),
          CLIENT_WAIT_MS,
        );
        waiters.current.push((c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
    },
  }).current;
}

export default function FixtureDrive() {
  const t = useTheme();
  const { status, fixture, pair, setPrimary, fleet, operatorTailnet, client } = useFleetContext();
  const clients = useNextClient(client);
  const { update: updatePrefs } = usePrefs();
  const params = useLocalSearchParams();
  const ran = useRef(false);

  const drive = fixture?.drive ?? null;
  useEffect(() => {
    if (ran.current) return;
    if (!drive) {
      ran.current = true;
      leave("/");
      return;
    }
    // Wait for the stored pairing to load: pairing over it before then would be undone.
    if (status === "loading" || !fixture) return;
    ran.current = true;
    const actions: FixtureDriveActions = {
      pair: async () => {
        const read = readPairingLink(fixture.link, { operatorTailnet });
        if (!read.ok) throw new Error(read.error.title);
        clients.markStale();
        const kept = await pair(read.link);
        const patch = pairPrefsPatch(read.link);
        if (Object.keys(patch).length > 0) updatePrefs(patch);
        if (kept === "switched") {
          // A new fleet remounts the app under this drive: run the same link
          // again once it has, when the pairing is this fleet's own.
          const query = new URLSearchParams();
          for (const [k, v] of Object.entries(params))
            for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) query.append(k, one);
          setTimeout(() => void Linking.openURL(`hermetic://fixture?${query}`), 500);
          return "restart";
        }
        return undefined;
      },
      setPrimary,
      // The fleet store, not the roster: a pairing in the same link has just
      // replaced the client this render holds. The roster follows the store,
      // and home reads the bots again when it opens.
      listen: async (name) => {
        await fleet.setListening(name, true);
      },
      createBot: async (instance, input) => {
        await (await clients.next()).createBot(instance, input);
      },
      setAvatarStyle: (avatarStyle) => updatePrefs({ avatarStyle }),
      setTheme: (preference) => t.setPreference(preference),
      warn: (message) => console.warn(`fixture drive: ${message}`),
    };
    void drive(params, actions).then(
      (to) => {
        if (to) leave(to);
      },
      (e: unknown) => {
        actions.warn(e instanceof Error ? e.message : String(e));
        leave("/");
      },
    );
  }, [
    drive,
    status,
    fixture,
    pair,
    setPrimary,
    fleet,
    operatorTailnet,
    updatePrefs,
    t,
    params,
    clients,
  ]);

  if (!drive) return null;
  return <View style={{ flex: 1, backgroundColor: t.c.bg }} />;
}
