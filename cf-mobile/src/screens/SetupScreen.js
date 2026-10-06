import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { Banner, Button, Card, Field } from '../components/ui';
import { getSettings, saveSettings, normaliseUrl, parseSetupPayload } from '../lib/store';
import { api, friendly } from '../lib/api';
import { T, text } from '../theme';

export default function SetupScreen({ navigation }) {
  const [apiUrl, setApiUrl] = useState('');
  const [deviceKey, setDeviceKey] = useState('');
  const [staffName, setStaffName] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');

  const [events, setEvents] = useState([]);
  const [eventId, setEventId] = useState('');

  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    getSettings().then((s) => {
      setApiUrl(s.apiUrl);
      setDeviceKey(s.deviceKey);
      setStaffName(s.staffName);
      setDeviceLabel(s.deviceLabel);
      setEventId(s.eventId);
      if (s.apiUrl && s.deviceKey) connect({ url: s.apiUrl, key: s.deviceKey, quiet: true });
    });
  }, []);

  async function connect({ url = apiUrl, key = deviceKey, quiet = false } = {}) {
    const cleanUrl = normaliseUrl(url);
    if (!cleanUrl || !key) {
      if (!quiet) setError('Enter both the server address and the device key.');
      return;
    }
    setChecking(true);
    setError(null);
    setStatus(null);
    try {
      // Settings must be saved first — the api client reads them, not these state vars.
      await saveSettings({ apiUrl: cleanUrl, deviceKey: key });
      setApiUrl(cleanUrl);

      const hello = await api.handshake();
      const { events: list } = await api.events();
      setEvents(list);
      await saveSettings({ interestTags: hello.interest_tags || [] });

      if (!list.length) {
        setStatus(null);
        setError('Connected, but no active or upcoming events exist yet. Create one in the admin console.');
        return;
      }
      // Default to the active event; at a stall there is normally exactly one.
      const active = list.find((e) => e.status === 'active') || list[0];
      if (!eventId || !list.some((e) => e.id === eventId)) setEventId(active.id);
      setStatus(`Connected to ${hello.brand.company}. ${list.length} event${list.length > 1 ? 's' : ''} available.`);
    } catch (err) {
      setError(friendly(err));
    } finally {
      setChecking(false);
    }
  }

  async function finish() {
    if (!staffName.trim()) {
      setError('Enter your name so leads can be credited to you.');
      return;
    }
    const ev = events.find((e) => e.id === eventId);
    if (!ev) {
      setError('Pick the event you are working.');
      return;
    }
    await saveSettings({
      staffName: staffName.trim(),
      deviceLabel: deviceLabel.trim(),
      eventId: ev.id,
      eventName: ev.name,
    });
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  }

  async function openScanner() {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        Alert.alert('Camera needed', 'Allow camera access to scan the setup code.');
        return;
      }
    }
    setScanning(true);
  }

  function onScanned({ data }) {
    setScanning(false);
    const parsed = parseSetupPayload(data);
    if (!parsed) {
      Alert.alert('Not a setup code', 'That QR does not contain a server address.');
      return;
    }
    setApiUrl(parsed.apiUrl);
    if (parsed.deviceKey) setDeviceKey(parsed.deviceKey);
    connect({ url: parsed.apiUrl, key: parsed.deviceKey || deviceKey });
  }

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onScanned}
        />
        <View style={{ position: 'absolute', bottom: 40, left: 20, right: 20 }}>
          <Button title="Cancel" variant="secondary" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Text style={[text.h1, { marginBottom: 4 }]}>Set up this phone</Text>
      <Text style={[text.hint, { marginBottom: 18 }]}>
        Once only. There is no password to remember — just point the app at the server and
        say who you are.
      </Text>

      {error ? <Banner tone="error">{error}</Banner> : null}
      {status ? <Banner tone="info">{status}</Banner> : null}

      <Card>
        <Text style={[text.h2, { marginBottom: 12 }]}>1 · Server</Text>

        <Button
          title="Scan setup QR from the admin console"
          variant="secondary"
          onPress={openScanner}
          style={{ marginBottom: 14 }}
        />

        <Field
          label="Server address"
          value={apiUrl}
          onChangeText={setApiUrl}
          placeholder="https://stall.chevellafarms.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Field
          label="Device key"
          value={deviceKey}
          onChangeText={setDeviceKey}
          placeholder="paste from Scanner app page"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Button title="Connect" onPress={() => connect()} busy={checking} />
      </Card>

      <Card>
        <Text style={[text.h2, { marginBottom: 12 }]}>2 · Who is holding this phone</Text>
        <Field
          label="Your name"
          value={staffName}
          onChangeText={setStaffName}
          placeholder="Swaroop"
          autoCapitalize="words"
          hint="Shown against every card you scan, so the follow-up lands with the right person."
        />
        <Field
          label="Phone label (optional)"
          value={deviceLabel}
          onChangeText={setDeviceLabel}
          placeholder="Stall phone 1"
        />
      </Card>

      <Card>
        <Text style={[text.h2, { marginBottom: 4 }]}>3 · Event</Text>
        <Text style={[text.hint, { marginBottom: 12 }]}>
          {events.length ? 'Every card you scan is filed against this event.' : 'Connect first to load the list.'}
        </Text>

        {events.map((e) => {
          const selected = e.id === eventId;
          return (
            <Pressable
              key={e.id}
              onPress={() => setEventId(e.id)}
              style={{
                borderWidth: 1.5,
                borderColor: selected ? T.leaf : T.line,
                backgroundColor: selected ? T.leafSoft : T.white,
                borderRadius: T.radiusSm,
                padding: 13,
                marginBottom: 9,
              }}
            >
              <Text style={{ fontWeight: '700', color: T.ink, fontSize: 15 }}>{e.name}</Text>
              <Text style={text.hint}>
                {[e.venue, e.stall_no && `Stall ${e.stall_no}`, e.city].filter(Boolean).join(' · ') || 'No venue set'}
              </Text>
              {e.status === 'active' ? (
                <Text style={{ color: T.leaf, fontSize: 12, fontWeight: '700', marginTop: 3 }}>● ACTIVE NOW</Text>
              ) : null}
            </Pressable>
          );
        })}
      </Card>

      <Button title="Start scanning" onPress={finish} disabled={!events.length} />
    </ScrollView>
  );
}
