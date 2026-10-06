import { SheetProps } from 'react-native-actions-sheet';
import { useTheme } from 'react-native-paper';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import useAuth from '../../hooks/useAuth';
import { PermissionEntity } from '../../models/role';
import WorkOrder from '../../models/workOrder';
import { useSelector } from '../../store';
import CustomActionSheet, {
  CustomActionSheetOption
} from './CustomActionSheet';

export default function WorkOrderDetailsSheet(
  props: SheetProps<{
    onEdit: () => void;
    onGenerateReport: () => void;
    onOpenArchive: () => void;
    onDelete: () => void;
    onOfflineHandoff: () => void;
    workOrder: WorkOrder;
  }>
) {
  const { t } = useTranslation();
  const { hasEditPermission, hasDeletePermission } = useAuth();
  const theme = useTheme();
  const hasCrew = useSelector(
    (state) => !!state.offline.packs[props.payload.workOrder.id]?.crew.length
  );
  const options: CustomActionSheetOption[] = [
    {
      title: t('offline_handoff'),
      icon: 'bluetooth-transfer',
      onPress: props.payload.onOfflineHandoff,
      visible: hasCrew
    },
    {
      title: t('edit'),
      icon: 'pencil',
      onPress: props.payload.onEdit,
      visible: hasEditPermission(
        PermissionEntity.WORK_ORDERS,
        props.payload.workOrder
      )
    },
    {
      title: t('to_export'),
      icon: 'download-outline',
      onPress: props.payload.onGenerateReport,
      visible: true
    },
    {
      title: t('archive'),
      icon: 'archive-outline',
      onPress: props.payload.onOpenArchive,
      visible: hasEditPermission(
        PermissionEntity.WORK_ORDERS,
        props.payload.workOrder
      )
    },
    {
      title: t('to_delete'),
      icon: 'delete-outline',
      onPress: props.payload.onDelete,
      color: theme.colors.error,
      visible: hasDeletePermission(
        PermissionEntity.WORK_ORDERS,
        props.payload.workOrder
      )
    }
  ];

  return <CustomActionSheet options={options} />;
}
