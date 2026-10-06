import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Network from 'expo-network';

import { Banner, Button, Card, Stat } from '../components/ui';
import { getSettings } from '../lib/store';
import { counts, flush, subscribe } from '../lib/queue';
import { T, text } from '../theme';

export default function HomeScreen({ navigation }) {
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState({ total: 0, pending: 0, done: 0, today: 0 });
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState(null);

  const refresh = useCallback(async () => {
    setSettings(await getSettings());
    setStats(await counts());
    const net = await Network.getNetworkStateAsync().catch(() => ({ isConnected: true }));
    setOnline(Boolean(net.isConnected));
  }, []);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  useEffect(() => subscribe(() => refresh()), [refresh]);

  async function syncNow() {
    setSyncing(true);
    setNote(null);
    try {
      const res = await flush({ force: true });
      if (res.offline) setNote('Still no connection. Everything is safe on this phone.');
      else if (res.nothing) setNote('Nothing waiting — all cards are uploaded.');
      else setNote(`Uploaded ${res.uploaded || 0}${res.failed ? `, ${res.failed} still waiting` : ''}.`);
    } finally {
      setSyncing(false);
      refresh();
    }
  }

  if (!settings) return null;

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
    >
      <Card style={{ backgroundColor: T.green800, borderColor: T.green800 }}>
        <Text style={{ color: '#8fbfa6', fontSize: 11, fontWeight: '700', letterSpacing: 0.6 }}>
          SCANNING FOR
        </Text>
        <Text style={{ color: '#fff', fontSize: 19, fontWeight: '700', marginTop: 3 }}>
          {settings.eventName || 'No event selected'}
        </Text>
        <Text style={{ color: '#8fbfa6', fontSize: 13, marginTop: 3 }}>
          as {settings.staffName}{settings.deviceLabel ? ` · ${settings.deviceLabel}` : ''}
        </Text>
      </Card>

      {!online && (
        <Banner tone="warn">
          No connection. Keep scanning — every card is saved on this phone and uploads by
          itself the moment you get signal.
        </Banner>
      )}
      {note ? <Banner tone="info">{note}</Banner> : null}

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
        <Stat label="Today" value={stats.today} />
        <Stat label="Uploaded" value={stats.done} />
        <Stat label="Waiting" value={stats.pending} tone={stats.pending ? 'warn' : undefined} />
      </View>

      <Button
        title="📷   Scan a visiting card"
        onPress={() => navigation.navigate('Camera')}
        style={{ paddingVertical: 22, marginBottom: 12 }}
      />

      <Button
        title={stats.pending ? `Sync now (${stats.pending} waiting)` : 'Sync now'}
        variant="secondary"
        onPress={syncNow}
        busy={syncing}
        style={{ marginBottom: 10 }}
      />

      <Button
        title="Captured cards"
        variant="ghost"
        onPress={() => navigation.navigate('Queue')}
        style={{ marginBottom: 10 }}
      />

      <Button
        title="Change event or settings"
        variant="ghost"
        onPress={() => navigation.navigate('Setup')}
      />

      <Text style={[text.hint, { marginTop: 22, textAlign: 'center' }]}>
        Lay the card flat, fill the frame, tap to focus. Scanning is instant — the upload
        and the text reading happen in the background.
      </Text>
    </ScrollView>
  );
}
