plugin "docker" {
  config {
    endpoint = "unix:///var/run/docker.sock"

    allow_privileged = false

    volumes {
      enabled = false
    }

    extra_labels = ["job_name", "task_group_name", "task_name", "namespace"]
  }
}

plugin "raw_exec" {
  config {
    enabled = false
  }
}
