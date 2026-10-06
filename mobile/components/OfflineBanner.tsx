import { Text, useTheme } from 'react-native-paper';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import useBackendReachability from '../hooks/useBackendReachability';

export function OfflineBanner() {
  const { t } = useTranslation();
  const theme = useTheme();
  const reachable = useBackendReachability();
  if (reachable) return null;
  return (
    <View style={{ backgroundColor: theme.colors.inverseSurface, padding: 6 }}>
      <Text
        style={{ color: theme.colors.inverseOnSurface, textAlign: 'center' }}
      >
        {t('offline_banner')}
      </Text>
    </View>
  );
}
