/**
 * The Bots list body: search, the All / Unread / Needs you chips, and the
 * grouped rows (pinned block, one collapsible header per listened instance,
 * the footer). The screen owns data and navigation; this draws.
 */
import { FlashList } from "@shopify/flash-list";
import { memo, useCallback } from "react";
import { Pressable, RefreshControl, TextInput, View } from "react-native";
import type { RailFilter } from "../client/roster-store.ts";
import type { RosterRow } from "../client/roster-rows.ts";
import type { Bot } from "../protocol/types.ts";
import { useTheme } from "../theme/theme.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { haptic } from "../ui/haptics.ts";
import { Kicker } from "../ui/Kicker.tsx";
import { SkeletonRow } from "../ui/Skeleton.tsx";
import { Text } from "../ui/Text.tsx";
import { BotRow } from "./BotRow.tsx";

const FILTERS: { id: RailFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "needs", label: "Needs you" },
];

export function FilterChips({
  value,
  needs,
  onChange,
}: {
  value: RailFilter;
  needs: number;
  onChange(filter: RailFilter): void;
}) {
  const t = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: t.space.xs }}>
      {FILTERS.map((f) => {
        const on = f.id === value;
        return (
          <Pressable
            key={f.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              haptic.select();
              onChange(f.id);
            }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: t.space.md,
              height: 32,
              borderWidth: t.border.control,
              borderColor: on ? t.c.fg : t.c.line2,
              backgroundColor: on ? t.c.fg : "transparent",
            }}
          >
            <Text
              variant="caption"
              weight={700}
              uppercase
              style={{ color: on ? t.c.bg : t.c.fg2, letterSpacing: 0.8 }}
            >
              {f.label}
            </Text>
            {f.id === "needs" && needs > 0 ? <Badge label="!" /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Header({
  row,
  onToggle,
}: {
  row: Extract<RosterRow, { kind: "head" }>;
  onToggle(instance: string): void;
}) {
  const t = useTheme();
  const foldable = row.instance !== null && row.reachable;
  const content = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.sm,
        paddingHorizontal: t.space.lg,
        minHeight: 36,
        backgroundColor: t.c.bg2,
        borderBottomWidth: 1,
        borderBottomColor: t.c.line,
        borderTopWidth: 1,
        borderTopColor: t.c.line,
      }}
    >
      {foldable ? (
        <Text mono variant="caption" tone="fg3" style={{ width: 10 }}>
          {row.folded ? "▸" : "▾"}
        </Text>
      ) : null}
      <Kicker tone={row.reachable ? "fg3" : "bad"} style={{ flexShrink: 1 }} numberOfLines={1}>
        {row.reachable ? row.label : `${row.label} · ${row.reason ?? "unreachable"}`}
      </Kicker>
      <Text mono variant="caption" tone="fg3">
        {row.count}
      </Text>
      <View style={{ flex: 1 }} />
      {row.folded ? <Badge label={row.badge} /> : null}
    </View>
  );
  if (!foldable) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !row.folded }}
      accessibilityLabel={`${row.label}, ${row.folded ? "folded" : "open"}`}
      onPress={() => {
        haptic.select();
        if (row.instance) onToggle(row.instance);
      }}
    >
      {content}
    </Pressable>
  );
}

export interface BotsListProps {
  rows: RosterRow[];
  loading: boolean;
  error: string | null;
  query: string;
  filter: RailFilter;
  needs: number;
  listening: number;
  fleetId: string;
  now: number;
  refreshing: boolean;
  onRefresh(): void;
  onQuery(q: string): void;
  onFilter(f: RailFilter): void;
  onOpen(bot: Bot): void;
  onMenu(bot: Bot, pinned: boolean): void;
  onToggle(instance: string): void;
  onPickInstances(): void;
}

function BotsListImpl(props: BotsListProps) {
  const t = useTheme();
  const { rows, fleetId, now } = props;
  const renderItem = useCallback(
    ({ item }: { item: RosterRow }) => {
      switch (item.kind) {
        case "head":
          return <Header row={item} onToggle={props.onToggle} />;
        case "bot":
          return (
            <BotRow
              bot={item.bot}
              fleetId={fleetId}
              pinned={item.pinned}
              badge={item.badge}
              reachable={item.reachable}
              now={now}
              onPress={props.onOpen}
              onLongPress={props.onMenu}
            />
          );
        case "unreachable":
          return (
            <Text variant="bodySmall" tone="fg3" style={{ padding: t.space.lg }}>
              {`No answer from ${item.instance}. Its bots come back when it does.`}
            </Text>
          );
        case "footer":
          return (
            <View style={{ padding: t.space.lg, gap: 2, alignItems: "center" }}>
              <Text mono variant="caption" tone="fg3">
                {item.roster}
              </Text>
              <Text mono variant="caption" tone={item.needs > 0 ? "warn" : "fg3"}>
                {item.attention}
              </Text>
            </View>
          );
      }
    },
    [t, fleetId, now, props.onToggle, props.onOpen, props.onMenu],
  );

  const searching = props.query.trim().length > 0 || props.filter !== "all";
  const empty = props.loading ? (
    <View>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <SkeletonRow key={i} />
      ))}
    </View>
  ) : props.error ? (
    <View style={{ padding: t.space.xl, gap: t.space.md }}>
      <Text tone="bad" weight={700}>
        Could not read the bots.
      </Text>
      <Text variant="bodySmall" tone="fg2">
        {props.error}
      </Text>
      <Button label="Try again" variant="secondary" onPress={props.onRefresh} />
    </View>
  ) : searching ? (
    <View style={{ padding: t.space.xl, gap: t.space.sm }}>
      <Text tone="fg2">Nothing matches.</Text>
      <Text variant="bodySmall" tone="fg3">
        {props.filter === "needs" ? "No bot is waiting on you." : "Try another search or filter."}
      </Text>
    </View>
  ) : (
    <View style={{ padding: t.space.xl, gap: t.space.md }}>
      <Text variant="title">
        {props.listening === 0 ? "Not listening to any instance." : "No bots yet."}
      </Text>
      <Text variant="bodySmall" tone="fg2">
        Only instances you listen to show their bots here, and only they raise notifications.
      </Text>
      <Button label="Choose instances" onPress={props.onPickInstances} />
    </View>
  );

  return (
    <FlashList
      data={rows.some((r) => r.kind !== "footer") ? rows : []}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.kind}
      renderItem={renderItem}
      extraData={now}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ paddingHorizontal: t.space.lg, paddingBottom: t.space.md, gap: t.space.sm }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              borderWidth: t.border.control,
              borderColor: t.c.line2,
              paddingLeft: t.space.md,
            }}
          >
            <Text mono tone="fg3">
              ⌕
            </Text>
            <TextInput
              accessibilityLabel="Search bots"
              value={props.query}
              onChangeText={props.onQuery}
              placeholder="Search bots"
              placeholderTextColor={t.c.fg3}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
              style={{
                flex: 1,
                height: 40,
                paddingHorizontal: t.space.sm,
                color: t.c.fg,
                fontFamily: t.sans(400),
                fontSize: 15,
              }}
            />
          </View>
          <FilterChips value={props.filter} needs={props.needs} onChange={props.onFilter} />
        </View>
      }
      ListEmptyComponent={empty}
      refreshControl={
        <RefreshControl tintColor={t.c.fg3} refreshing={props.refreshing} onRefresh={props.onRefresh} />
      }
    />
  );
}

export const BotsList = memo(BotsListImpl);
