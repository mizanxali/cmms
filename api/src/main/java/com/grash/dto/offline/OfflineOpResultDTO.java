package com.grash.dto.offline;

import com.grash.model.enums.OfflineOpResult;
import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class OfflineOpResultDTO {
    private String opId;
    private OfflineOpResult result;
    private String detail;
    private Long uploadedBy;
    private Long firstSyncedAt;
}
