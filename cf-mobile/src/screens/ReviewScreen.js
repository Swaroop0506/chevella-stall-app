import { useEffect, useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';

import { Banner, Button, Card, Chip, Field } from '../components/ui';
import { annotate, listQueue } from '../lib/queue';
import { getSettings } from '../lib/store';
import { T, text } from '../theme';

const FALLBACK_TAGS = [
  'Instant Coconut Water Powder', 'Tender Coconut Water', 'Bulk / Distributor',
  'Retail / Store', 'HoReCa', 'Export', 'Private Label', 'Just browsing',
];

export default function ReviewScreen({ route, navigation }) {
  const { captureId } = route.params || {};
  const [item, setItem] = useState(null);
  const [tags, setTags] = useState([]);
  const [notes, setNotes] = useState('');
  const [available, setAvailable] = useState(FALLBACK_TAGS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const found = (await listQueue()).find((q) => q.id === captureId);
      setItem(found || null);
      setTags(found?.tags || []);
      setNotes(found?.notes || '');
      const s = await getSettings();
      if (s.interestTags?.length) setAvailable(s.interestTags);
    })();
  }, [captureId]);

  function toggle(tag) {
    setTags((t) => (t.includes(tag) ? t.filter((x) => x !== tag) : [...t, tag]));
  }

  async function save() {
    setSaving(true);
    try {
      await annotate(captureId, { tags, notes: notes.trim() });
      navigation.goBack();
    } finally {
      setSaving(false);
    }
  }

  if (!item) {
    return (
      <View style={{ padding: 20 }}>
        <Text style={text.hint}>That capture is no longer in the queue.</Text>
      </View>
    );
  }

  const fields = item.fields;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 44 }}>
      {item.uri ? (
        <Image
          source={{ uri: item.uri }}
          style={{ width: '100%', aspectRatio: 1.6, borderRadius: T.radius, marginBottom: 14, backgroundColor: T.sand }}
          resizeMode="cover"
        />
      ) : null}

      {item.status !== 'done' ? (
        <Banner tone="warn">
          Saved on this phone. The text is read on the server once it uploads, so the
          details below will fill in later — nothing is lost in the meantime.
        </Banner>
      ) : null}

      {item.duplicateOf ? (
        <Banner tone="warn">
          Looks like a repeat: {item.duplicateOf} was already captured at this event with
          the same number. It is saved anyway — the admin can merge them.
        </Banner>
      ) : null}

      {fields ? (
        <Card>
          <Text style={[text.h2, { marginBottom: 10 }]}>What the server read</Text>
          {[
            ['Name', fields.full_name],
            ['Company', fields.company],
            ['Role', fields.designation],
            ['Phone', fields.phone_primary],
            ['Email', fields.email],
            ['City', fields.city],
          ].map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', paddingVertical: 4 }}>
              <Text style={[text.label, { width: 84 }]}>{k}</Text>
              <Text style={[text.body, { flex: 1, color: v ? T.ink : T.muted }]}>{v || '—'}</Text>
            </View>
          ))}
          <Text style={[text.hint, { marginTop: 10 }]}>
            {item.needsReview
              ? 'Flagged for a human to check in the admin console.'
              : 'Read cleanly. No review needed.'}
          </Text>
        </Card>
      ) : null}

      <Card>
        <Text style={[text.h2, { marginBottom: 4 }]}>What are they interested in?</Text>
        <Text style={[text.hint, { marginBottom: 12 }]}>
          Tap any that apply. This is what makes the follow-up worth reading.
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {available.map((tag) => (
            <Chip key={tag} label={tag} selected={tags.includes(tag)} onPress={() => toggle(tag)} />
          ))}
        </View>
      </Card>

      <Card>
        <Field
          label="Note"
          value={notes}
          onChangeText={setNotes}
          multiline
          placeholder="Wants a sample pack couriered. Buys ~200 kg a month for 3 outlets."
          hint="Anything you would otherwise forget by the end of the day."
        />
      </Card>

      <Button title="Save" onPress={save} busy={saving} />
      <Button
        title="Skip"
        variant="ghost"
        onPress={() => navigation.goBack()}
        style={{ marginTop: 10 }}
      />
    </ScrollView>
  );
}
