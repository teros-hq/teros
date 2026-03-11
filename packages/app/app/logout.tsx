/**
 * Logout page - Limpia sesión y redirige a login
 */

import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Text, YStack } from 'tamagui';
import { STORAGE_KEYS, storage } from '../src/services/storage';
import { getTerosClient } from './_layout';

export default function LogoutPage() {
  const router = useRouter();

  useEffect(() => {
    const logout = async () => {
      try {
        // Limpiar storage
        await storage.removeItem(STORAGE_KEYS.USER);

        // Limpiar cliente
        const client = getTerosClient();
        client.setSessionToken('');
        client.disconnect();

        // Limpiar localStorage (por si hay datos corruptos)
        if (typeof localStorage !== 'undefined') {
          localStorage.clear();
        }

        console.log('✅ Session cleared');
      } catch (e) {
        console.error('Error during logout:', e);
      }

      // Redirigir a login
      router.replace('/(auth)/login');
    };

    logout();
  }, []);

  return (
    <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor="#000">
      <Text color="#666">Cerrando sesión...</Text>
    </YStack>
  );
}
