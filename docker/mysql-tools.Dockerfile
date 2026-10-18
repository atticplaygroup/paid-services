FROM mysql:8.0.42-oraclelinux9

USER root
RUN rm -f /etc/yum.repos.d/mysql-community*.repo && microdnf install -y jq util-linux python3-pip && microdnf clean all && pip3 install --no-cache-dir awscli==1.42.30

RUN microdnf install -y cpio && microdnf clean all && \
    curl -fsSL "https://repo.mysql.com/yum/mysql-8.0-community/el/9/x86_64/mysql-community-client-8.0.42-1.el9.x86_64.rpm" -o /tmp/client.rpm && \
    rpm2cpio /tmp/client.rpm > /tmp/client.cpio && mkdir -p /tmp/client-extract && \
    cd /tmp/client-extract && cpio -idm < /tmp/client.cpio && \
    mv /tmp/client-extract/usr/bin/mysqlbinlog /usr/local/bin/mysqlbinlog && \
    rm -rf /tmp/client* && microdnf remove -y cpio && microdnf clean all

ARG YQ_VERSION=4.45.1
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64" \
    -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

ARG ORAS_VERSION=1.2.0
RUN curl -fsSL "https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /usr/local/bin oras && chmod +x /usr/local/bin/oras

ARG SUPERCRONIC_VERSION=0.2.34
RUN curl -fsSL "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
    -o /usr/local/bin/supercronic && chmod +x /usr/local/bin/supercronic

COPY charts/mysql-proposer/files/mysql-export-baseline.js /usr/local/bin/mysql-export-baseline.js
COPY charts/mysql-proposer/files/mysql-export-binlogs.sh /usr/local/bin/mysql-export-binlogs.sh
COPY charts/mysql-proposer/files/*.sh /usr/local/bin/
COPY charts/mysql-proposer/files/mysql-binlog-coverage.js /usr/local/bin/mysql-binlog-coverage.js
COPY charts/mysql-replica/files/mysql-import-baseline.js /usr/local/bin/mysql-import-baseline.js
COPY charts/mysql-replica/files/mysql-import-binlogs.sh /usr/local/bin/mysql-import-binlogs.sh
COPY charts/mysql-replica/files/*.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/mysql-binlog-coverage.js /usr/local/bin/mysql-export-* /usr/local/bin/publish* /usr/local/bin/mysql-import-* /usr/local/bin/import.sh /usr/local/bin/sync.sh

ENTRYPOINT []
CMD ["bash"]
