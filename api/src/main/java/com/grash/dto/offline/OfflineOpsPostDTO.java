package com.grash.dto.offline;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.util.List;

@Data
public class OfflineOpsPostDTO {
    @NotNull
    @Size(max = 200)
    private List<OfflineEnvelopeDTO> ops;
}
