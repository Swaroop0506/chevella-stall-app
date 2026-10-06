import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import SetupScreen from './src/screens/SetupScreen';
import HomeScreen from './src/screens/HomeScreen';
import CameraScreen from './src/screens/CameraScreen';
import ReviewScreen from './src/screens/ReviewScreen';
import QueueScreen from './src/screens/QueueScreen';
import { getSettings, isConfigured } from './src/lib/store';
import { flush, pruneDone } from './src/lib/queue';
import { T } from './src/theme';

const Stack = createNativeStackNavigator();

const screenOptions = {
  headerStyle: { backgroundColor: T.green800 },
  headerTintColor: '#fff',
  headerTitleStyle: { fontWeight: '700' },
  contentStyle: { backgroundColor: T.cream },
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      setConfigured(isConfigured(s));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    // Two triggers for draining the queue, because a phone at a stall spends most of its
    // time with the screen off: a timer while the app is open, and a push the moment it
    // comes back to the foreground (which is usually when it has just found signal).
    const timer = setInterval(() => { flush().catch(() => {}); }, 30_000);

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        flush().catch(() => {});
        pruneDone({ olderThanHours: 24 }).catch(() => {});
      }
    });

    flush().catch(() => {});
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: T.green800, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor={T.green800} />
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName={configured ? 'Home' : 'Setup'}
          screenOptions={screenOptions}
        >
          <Stack.Screen name="Setup" component={SetupScreen} options={{ title: 'Setup' }} />
          <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Chevella Scanner' }} />
          <Stack.Screen
            name="Camera"
            component={CameraScreen}
            options={{ title: 'Scan card', headerShown: false, animation: 'fade' }}
          />
          <Stack.Screen name="Review" component={ReviewScreen} options={{ title: 'Add details' }} />
          <Stack.Screen name="Queue" component={QueueScreen} options={{ title: 'Captured cards' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
