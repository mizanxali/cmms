package com.grash.controller;

import com.grash.dto.offline.OfflineCrewMemberDTO;
import com.grash.dto.offline.OfflineDevicePostDTO;
import com.grash.dto.offline.OfflineDeviceShowDTO;
import com.grash.dto.offline.OfflineOpsPostDTO;
import com.grash.dto.offline.OfflineOpsResultDTO;
import com.grash.model.OfflineDevice;
import com.grash.model.User;
import com.grash.security.CurrentUser;
import com.grash.service.OfflineDeviceService;
import com.grash.service.OfflineSyncService;
import io.swagger.v3.oas.annotations.Parameter;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/offline")
@RequiredArgsConstructor
public class OfflineController {

    private final OfflineDeviceService offlineDeviceService;
    private final OfflineSyncService offlineSyncService;

    @PostMapping("/devices")
    @PreAuthorize("hasRole('ROLE_CLIENT')")
    public OfflineDeviceShowDTO registerDevice(@Valid @RequestBody OfflineDevicePostDTO dto,
                                               @Parameter(hidden = true) @CurrentUser User user) {
        OfflineDevice device = offlineDeviceService.register(dto, user);
        return new OfflineDeviceShowDTO(device.getId(), device.getAddress());
    }

    @GetMapping("/work-orders/{id}/crew")
    @PreAuthorize("hasRole('ROLE_CLIENT')")
    public List<OfflineCrewMemberDTO> getCrew(@PathVariable Long id,
                                              @Parameter(hidden = true) @CurrentUser User user) {
        return offlineDeviceService.getCrew(id, user);
    }

    // 200 even when some ops fail; each op carries its own result
    @PostMapping("/ops")
    @PreAuthorize("hasRole('ROLE_CLIENT')")
    public OfflineOpsResultDTO syncOps(@Valid @RequestBody OfflineOpsPostDTO dto,
                                       @Parameter(hidden = true) @CurrentUser User user) {
        return new OfflineOpsResultDTO(offlineSyncService.sync(dto.getOps(), user));
    }
}
