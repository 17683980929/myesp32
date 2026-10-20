idf_component_register(
    SRCS "audio.c" "wake.c"
    INCLUDE_DIRS "include"
    REQUIRES driver hw net
)
