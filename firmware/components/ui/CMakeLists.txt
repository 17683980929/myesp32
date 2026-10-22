idf_component_register(
    SRCS "ui.c" "font5x7.c" "font_cjk.c" "pet_frames.c" "pet_water.c"
    INCLUDE_DIRS "include" "."
    REQUIRES hw net ble
)
