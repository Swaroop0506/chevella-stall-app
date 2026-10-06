import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Image, Pressable, Text, View } from 'react-native';

import { Banner, Button } from '../components/ui';
import { flush, listQueue, removeItem, subscribe } from '../lib/queue';
import { T, text } from '../theme';

const STATUS = {
  done: { label: 'uploaded', bg: T.leafSoft, fg: T.green700 },
  pending: { label: 'waiting', bg: T.amberSoft, fg: T.amber },
  uploading: { label: 'uploading…', bg: '#e8f0fb', fg: '#1a5fb4' },
};

const ERRORS = {
  offline: 'no connection yet',
  timeout: 'server was slow — will retry',
  bad_device_key: 'device key rejected — check Setup',
  event_not_found: 'event missing on server',
};

function Row({ item, onRemove }) {
  const st = STATUS[item.status] || STATUS.pending;
  const when = new Date(item.capturedAt).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
  });

  return (
    <View style={{
      flexDirection: 'row', gap: 12, padding: 12, backgroundColor: T.white,
      borderWidth: 1, borderColor: T.line, borderRadius: T.radius, marginBottom: 10,
    }}>
      {item.uri && item.status !== 'done' ? (
        <Image source={{ uri: item.uri }} style={{ width: 64, height: 42, borderRadius: 6, backgroundColor: T.sand }} />
      ) : (
        <View style={{
          width: 64, height: 42, borderRadius: 6, backgroundColor: T.leafSoft,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={{ color: T.leaf, fontWeight: '700' }}>✓</Text>
        </View>
      )}

      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: '700', color: T.ink, fontSize: 15 }} numberOfLines={1}>
          {item.fields?.full_name || item.fields?.company || `Card at ${when}`}
        </Text>
        <Text style={text.hint} numberOfLines={1}>
          {item.fields?.company && item.fields?.full_name
            ? item.fields.company
            : `${when} · ${item.capturedBy || 'unknown'}`}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 }}>
          <View style={{ backgroundColor: st.bg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 }}>
            <Text style={{ color: st.fg, fontSize: 11, fontWeight: '700' }}>{st.label}</Text>
          </View>
          {item.status !== 'done' && item.lastError ? (
            <Text style={{ fontSize: 11.5, color: T.muted, flex: 1 }} numberOfLines={1}>
              {ERRORS[item.lastError] || item.lastError}
              {item.attempts > 1 ? ` (${item.attempts} tries)` : ''}
            </Text>
          ) : null}
          {item.needsReview ? (
            <Text style={{ fontSize: 11.5, color: T.amber, fontWeight: '600' }}>needs review</Text>
          ) : null}
        </View>
      </View>

      {item.status !== 'done' && item.attempts >= 4 ? (
        <Pressable onPress={() => onRemove(item)} hitSlop={10} style={{ justifyContent: 'center' }}>
          <Text style={{ color: T.red, fontSize: 12, fontWeight: '700' }}>Drop</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function QueueScreen() {
  const [items, setItems] = useState([]);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => setItems(await listQueue()), []);

  useEffect(() => {
    load();
    return subscribe(setItems);
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    try { await flush({ force: true }); } finally { setSyncing(false); load(); }
  }

  function confirmRemove(item) {
    Alert.alert(
      'Drop this card?',
      'The photo is deleted from this phone and never reaches the server. Only do this if the photo is unusable.',
      [
        { text: 'Keep trying', style: 'cancel' },
        { text: 'Drop', style: 'destructive', onPress: () => removeItem(item.id) },
      ],
    );
  }

  const pending = items.filter((i) => i.status !== 'done').length;

  return (
    <View style={{ flex: 1, padding: 16 }}>
      {pending > 0 ? (
        <Banner tone="warn">
          {pending} card{pending > 1 ? 's' : ''} still on this phone. They upload by
          themselves — do not uninstall the app until this reaches zero.
        </Banner>
      ) : (
        <Banner tone="info">Everything is uploaded. Safe to close the app.</Banner>
      )}

      <Button
        title={syncing ? 'Syncing…' : 'Sync now'}
        variant="secondary"
        onPress={syncNow}
        busy={syncing}
        style={{ marginBottom: 14 }}
      />

      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={({ item }) => <Row item={item} onRemove={confirmRemove} />}
        ListEmptyComponent={
          <Text style={[text.hint, { textAlign: 'center', marginTop: 40 }]}>
            No cards captured yet.
          </Text>
        }
        contentContainerStyle={{ paddingBottom: 30 }}
      />
    </View>
  );
}
