import { useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../components/ui';
import { enqueueCapture } from '../lib/queue';
import { T } from '../theme';

/**
 * Two states on one screen: live viewfinder, then a confirm step on the frozen frame.
 *
 * The confirm step exists because the cost of a bad photo is asymmetric — a retake costs
 * three seconds, a blurry card costs a lead nobody can follow up. The guide rectangle is
 * 1.75:1, the ISO 7810 ID-1 ratio that virtually every visiting card uses.
 */
export default function CameraScreen({ navigation }) {
  const camera = useRef(null);
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [shot, setShot] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!permission) {
    return <View style={s.black}><ActivityIndicator color="#fff" /></View>;
  }

  if (!permission.granted) {
    return (
      <View style={[s.black, { padding: 24, justifyContent: 'center' }]}>
        <Text style={s.permTitle}>Camera access needed</Text>
        <Text style={s.permBody}>
          The app photographs visiting cards. It never records audio and never reads your
          photo library.
        </Text>
        <Button title="Allow camera" onPress={requestPermission} style={{ marginTop: 20 }} />
        <Button title="Go back" variant="ghost" onPress={() => navigation.goBack()} style={{ marginTop: 10 }} />
      </View>
    );
  }

  async function capture() {
    if (busy || !camera.current) return;
    setBusy(true);
    try {
      const photo = await camera.current.takePictureAsync({
        quality: 1,            // compression happens in the queue, at a known size
        skipProcessing: false, // let the OS apply its own sharpening/exposure fixes
        exif: true,
      });
      setShot(photo);
    } catch {
      setBusy(false);
    } finally {
      setBusy(false);
    }
  }

  /** Saves and goes straight back to the viewfinder — the fast path for a queue of people. */
  async function keepAndContinue() {
    setBusy(true);
    try {
      await enqueueCapture({ uri: shot.uri });
      setShot(null);
    } finally {
      setBusy(false);
    }
  }

  /** Saves and opens the review screen to add tags and a note. */
  async function keepAndAnnotate() {
    setBusy(true);
    try {
      const entry = await enqueueCapture({ uri: shot.uri });
      setShot(null);
      navigation.navigate('Review', { captureId: entry.id });
    } finally {
      setBusy(false);
    }
  }

  if (shot) {
    return (
      <View style={s.black}>
        <Image source={{ uri: shot.uri }} style={s.preview} resizeMode="contain" />
        <View style={[s.confirmBar, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={s.confirmHint}>
            Readable? Check the phone number and email are sharp.
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title="Retake" variant="secondary" onPress={() => setShot(null)} style={{ flex: 1 }} />
            <Button title="Keep & next" onPress={keepAndContinue} busy={busy} style={{ flex: 1.3 }} />
          </View>
          <Pressable onPress={keepAndAnnotate} disabled={busy} style={{ paddingVertical: 12 }}>
            <Text style={s.linkish}>Keep and add a note / interest →</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={s.black}>
      <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" autofocus="on" />

      {/* Framing guide */}
      <View style={s.overlay} pointerEvents="none">
        <View style={s.guide}>
          <View style={[s.corner, s.tl]} />
          <View style={[s.corner, s.tr]} />
          <View style={[s.corner, s.bl]} />
          <View style={[s.corner, s.br]} />
        </View>
        <Text style={s.guideText}>Fill this box with the card</Text>
      </View>

      <View style={[s.shutterBar, { paddingBottom: insets.bottom + 18 }]}>
        <Pressable onPress={() => navigation.goBack()} style={s.sideBtn} hitSlop={12}>
          <Text style={s.sideText}>Close</Text>
        </Pressable>

        <Pressable onPress={capture} disabled={busy} style={s.shutterOuter}>
          <View style={s.shutterInner}>
            {busy ? <ActivityIndicator color={T.green800} /> : null}
          </View>
        </Pressable>

        <View style={s.sideBtn} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  black: { flex: 1, backgroundColor: '#000' },
  preview: { flex: 1 },

  permTitle: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  permBody: { color: '#bbb', fontSize: 15, lineHeight: 21 },

  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  guide: {
    width: '86%',
    aspectRatio: 1.75,          // ISO ID-1, the standard visiting-card shape
    borderRadius: 12,
  },
  corner: {
    position: 'absolute', width: 34, height: 34,
    borderColor: '#fff', borderWidth: 0,
  },
  tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 12 },
  tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 12 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 12 },
  br: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 12 },
  guideText: {
    color: '#fff', fontSize: 13.5, marginTop: 18,
    backgroundColor: 'rgba(0,0,0,.45)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
  },

  shutterBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 28, paddingTop: 18,
    backgroundColor: 'rgba(0,0,0,.4)',
  },
  sideBtn: { width: 64 },
  sideText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  shutterOuter: {
    width: 78, height: 78, borderRadius: 39,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: {
    width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },

  confirmBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: 16, backgroundColor: 'rgba(0,0,0,.78)',
  },
  confirmHint: { color: '#ddd', fontSize: 13.5, textAlign: 'center', marginBottom: 12 },
  linkish: { color: '#8fd3ab', fontSize: 14.5, textAlign: 'center', fontWeight: '600' },
});
