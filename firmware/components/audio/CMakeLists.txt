idf_component_register(
    SRCS "audio.c" "wake.c" "greeting_opus.c"
    INCLUDE_DIRS "include"
    REQUIRES driver hw net
)
