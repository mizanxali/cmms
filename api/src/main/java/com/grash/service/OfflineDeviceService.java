package com.grash.service;

import com.grash.dto.offline.OfflineCrewMemberDTO;
import com.grash.dto.offline.OfflineDevicePostDTO;
import com.grash.exception.CustomException;
import com.grash.model.OfflineDevice;
import com.grash.model.User;
import com.grash.model.WorkOrder;
import com.grash.repository.OfflineDeviceRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.List;

@Service
@RequiredArgsConstructor
public class OfflineDeviceService {

    private final OfflineDeviceRepository offlineDeviceRepository;
    private final WorkOrderService workOrderService;

    @Transactional
    public OfflineDevice register(OfflineDevicePostDTO dto, User user) {
        byte[] publicKey = decode(dto.getPublicKey());
        if (publicKey == null || publicKey.length != 32)
            throw new CustomException("publicKey must be 32 bytes, base64", HttpStatus.BAD_REQUEST);
        // The address is self-certifying, so nobody can claim another device's address with their own key
        if (!deriveAddress(publicKey).equals(dto.getAddress()))
            throw new CustomException("address does not match publicKey", HttpStatus.BAD_REQUEST);
        offlineDeviceRepository.findOwnerIdByAddress(dto.getAddress()).ifPresent(ownerId -> {
            if (!ownerId.equals(user.getId()))
                throw new CustomException("Address registered to another user", HttpStatus.CONFLICT);
        });
        OfflineDevice device = offlineDeviceRepository.findByAddress(dto.getAddress()).orElseGet(() -> {
            OfflineDevice created = new OfflineDevice();
            created.setUser(user);
            created.setAddress(dto.getAddress());
            return created;
        });
        device.setPublicKey(dto.getPublicKey());
        return offlineDeviceRepository.save(device);
    }

    @Transactional(readOnly = true)
    public List<OfflineCrewMemberDTO> getCrew(Long workOrderId, User user) {
        WorkOrder workOrder = workOrderService.checkAccessToWorkOrderId(workOrderId, user);
        return offlineDeviceRepository.findByCompany_Id(user.getCompany().getId()).stream()
                .filter(device -> workOrder.canBeEditedBy(device.getUser()))
                .map(device -> new OfflineCrewMemberDTO(device.getUser().getId(), device.getUser().getFirstName(),
                        device.getUser().getLastName(), device.getAddress(), device.getPublicKey()))
                .toList();
    }

    private static byte[] decode(String base64) {
        try {
            return Base64.getDecoder().decode(base64);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static final String BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    private static final int BECH32M_CONST = 0x2bc830a3;

    /**
     * The SDK's address of an Ed25519 key: bech32m with HRP "off" over {@code 0x01 || SHA-256(publicKey)[0:20]}.
     */
    public static String deriveAddress(byte[] publicKey) {
        byte[] payload = new byte[21];
        payload[0] = 1;
        try {
            System.arraycopy(MessageDigest.getInstance("SHA-256").digest(publicKey), 0, payload, 1, 20);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        int[] data = new int[34]; // 168 bits regrouped into 5-bit words, zero-padded
        int acc = 0, bits = 0, n = 0;
        for (byte b : payload) {
            acc = (acc << 8) | (b & 0xff);
            bits += 8;
            while (bits >= 5) data[n++] = (acc >> (bits -= 5)) & 31;
        }
        if (bits > 0) data[n] = (acc << (5 - bits)) & 31;
        String hrp = "off";
        int[] values = new int[hrp.length() * 2 + 1 + data.length + 6];
        int i = 0;
        for (char c : hrp.toCharArray()) values[i++] = c >> 5;
        values[i++] = 0;
        for (char c : hrp.toCharArray()) values[i++] = c & 31;
        System.arraycopy(data, 0, values, i, data.length);
        int polymod = polymod(values) ^ BECH32M_CONST;
        StringBuilder out = new StringBuilder(hrp).append('1');
        for (int d : data) out.append(BECH32_CHARSET.charAt(d));
        for (int k = 0; k < 6; k++) out.append(BECH32_CHARSET.charAt((polymod >> (5 * (5 - k))) & 31));
        return out.toString();
    }

    private static int polymod(int[] values) {
        int[] gen = {0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3};
        int chk = 1;
        for (int v : values) {
            int top = chk >>> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ v;
            for (int k = 0; k < 5; k++) if (((top >> k) & 1) == 1) chk ^= gen[k];
        }
        return chk;
    }
}
