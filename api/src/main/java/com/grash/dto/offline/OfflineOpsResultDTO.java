package com.grash.dto.offline;

import lombok.AllArgsConstructor;
import lombok.Data;

import java.util.List;

@Data
@AllArgsConstructor
public class OfflineOpsResultDTO {
    private List<OfflineOpResultDTO> results;
}
